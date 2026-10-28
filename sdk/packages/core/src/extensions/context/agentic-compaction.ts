import type { BasicLogger } from "@cline/shared";
import { createAgentModelFromConfig } from "../../services/llms/handler-factory";
import { countUserRunMessages } from "../../session/user-run-messages";
import type {
	CoreCompactionContext,
	CoreCompactionResult,
	CoreCompactionSummarizerConfig,
} from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import {
	type BudgetProjectionResult,
	buildBudgetProjection,
} from "./budget-projection";
import {
	buildSummaryMessage,
	buildSummaryRequest,
	DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
	type EstimateMessageTokens,
	ensureFilesSection,
	estimateTokens,
	extractFileOps,
	findCutIndex,
	findLatestSummaryIndex,
	getCompactionSummaryMetadata,
	isTurnStartMessage,
	resolveProviderMaxInputTokens,
	resolveSummarizerConfig,
	serializeConversation,
} from "./compaction-shared";
import { generateSummary as generateSummaryOnce } from "./summary-generation";

const MIN_AGENTIC_SUMMARY_INPUT_TOKENS = 1_024;

export function buildAgenticSummaryInputBudget(options: {
	messages: CoreCompactionContext["messages"];
	targetTokens: number;
	estimateMessageTokens: EstimateMessageTokens;
}): BudgetProjectionResult {
	return buildBudgetProjection({
		messages: options.messages,
		targetTokens: Math.max(1, options.targetTokens),
		policyIntent: "agentic_summary",
		estimateMessageTokens: options.estimateMessageTokens,
	});
}

/** Retry one complete empty compaction response using the exact same request. */
async function generateSummary(
	options: Parameters<typeof generateSummaryOnce>[0] & { logger?: BasicLogger },
) {
	const result = await generateSummaryOnce(options);
	if (
		result.text.trim() ||
		result.incompleteReason ||
		result.failed ||
		result.usedTools
	)
		return result;
	options.signal?.throwIfAborted();
	options.providerConfig.abortSignal?.throwIfAborted();
	options.logger?.log("Retrying empty compaction summary", {
		severity: "warn",
		attempt: 2,
		maxAttempts: 2,
		reason: "empty_summary",
		reasoningChars: result.reasoningChars,
		modelId: options.providerConfig.modelId,
	});
	return generateSummaryOnce(options);
}

async function summarizeMeasuredChunks(options: {
	providerConfig: ProviderConfig;
	data: string;
	fileOps: ReturnType<typeof extractFileOps>;
	signal: AbortSignal;
	logger?: BasicLogger;
}): Promise<string> {
	const instruction =
		"Summarize the provided coding session into a concise continuation note with detailed next steps.";
	const counter = createAgentModelFromConfig(
		{
			providerId: options.providerConfig.providerId,
			modelId: options.providerConfig.modelId,
			providerConfig: options.providerConfig,
			systemPrompt: instruction,
			tools: [],
		},
		undefined,
	);
	let position = 0,
		checkpoint = "",
		segments = 0;
	do {
		options.signal.throwIfAborted();
		let size = Math.min(80000, options.data.length - position);
		let request = "";
		for (let attempt = 0; attempt < 18; attempt++) {
			request = buildSummaryRequest({
				previousSummary: checkpoint,
				conversationText: options.data.slice(position, position + size),
				fileOps: options.fileOps,
			});
			const count = await counter.countInputTokens?.({
				systemPrompt: instruction,
				messages: [
					{
						id: "summary-count",
						createdAt: 0,
						role: "user",
						content: [{ type: "text", text: request }],
					},
				],
				tools: [],
				signal: options.signal,
				options: {
					maxTokens: options.providerConfig.maxOutputTokens,
					thinking: false,
				},
			});
			if (!count)
				throw new Error(
					"Summarizer input token counting unavailable; original context was preserved",
				);
			if (count.inputTokens <= Math.min(24000, count.maxInputTokens)) break;
			if (size <= 1 || attempt === 17)
				throw new Error(
					"Summarizer instructions and checkpoint cannot fit the measured input allowance",
				);
			size = Math.max(1, Math.floor(size / 2));
		}
		options.signal.throwIfAborted();
		const generated = await generateSummary({
			providerConfig: {
				...options.providerConfig,
				abortSignal: options.signal,
			},
			systemPrompt: instruction,
			signal: options.signal,
			request,
			logger: options.logger,
		});
		if (
			!generated.text.trim() ||
			generated.incompleteReason ||
			generated.failed ||
			generated.usedTools
		)
			throw new Error(
				"Summarizer returned an empty or incomplete checkpoint; original context was preserved",
			);
		checkpoint = generated.text;
		position += size;
		if (++segments >= 64 && position < options.data.length)
			throw new Error(
				"Compaction exceeded the bounded summary segment limit; original context was preserved",
			);
	} while (position < options.data.length);
	return ensureFilesSection(checkpoint, options.fileOps);
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

export async function runAgenticCompaction(options: {
	context: CoreCompactionContext;
	providerConfig: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
	preserveRecentTokens?: number;
	estimateMessageTokens: EstimateMessageTokens;
	logger?: BasicLogger;
}): Promise<CoreCompactionResult | undefined> {
	const messages = options.context.messages;
	if (messages.length < 2) {
		return undefined;
	}

	const summarizerProviderConfig = resolveSummarizerConfig({
		activeProviderConfig: options.providerConfig,
		summarizer: options.summarizer,
	});
	// Retain history toward the preferred full-request size, rather than a
	// fixed 20K suffix. The caller has removed request overhead and clamped
	// this message budget to the configured maximum and live input allowance.
	const summaryReserveTokens =
		summarizerProviderConfig.maxOutputTokens ??
		DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS;
	let preserveRecentTokens = Math.max(
		0,
		Math.min(
			options.preserveRecentTokens ?? Number.POSITIVE_INFINITY,
			options.context.budget.messages.targetTokens - summaryReserveTokens,
		),
	);
	let cutIndex = findCutIndex(
		messages,
		preserveRecentTokens,
		options.estimateMessageTokens,
	);
	const latestTypedIndex = messages.map(isTurnStartMessage).lastIndexOf(true);
	// A user instruction outside the retained tail is reinserted verbatim;
	// reserve its space separately so it does not silently consume headroom.
	const protectedPromptTokens =
		latestTypedIndex >= 0 && latestTypedIndex < cutIndex
			? options.estimateMessageTokens(messages[latestTypedIndex])
			: 0;
	if (protectedPromptTokens > 0) {
		preserveRecentTokens = Math.max(
			0,
			preserveRecentTokens - protectedPromptTokens,
		);
		cutIndex = findCutIndex(
			messages,
			preserveRecentTokens,
			options.estimateMessageTokens,
		);
	}
	if (cutIndex <= 0 || cutIndex >= messages.length) {
		return undefined;
	}
	options.logger?.debug("Agentic compaction retention budget", {
		preferredTargetTokens: options.context.budget.request.targetTokens,
		requestOverheadTokens: options.context.budget.request.overheadTokens,
		messageTargetTokens: options.context.budget.messages.targetTokens,
		summaryReserveTokens,
		protectedPromptTokens,
		preserveRecentTokens,
		messagesPreserved: messages.length - cutIndex,
	});

	const messagesToSummarize = messages.slice(0, cutIndex);
	const protectedPrompt =
		latestTypedIndex >= 0 && latestTypedIndex < cutIndex
			? messages[latestTypedIndex]
			: undefined;
	const latestSummaryIndex = findLatestSummaryIndex(messagesToSummarize);
	const previousSummary =
		latestSummaryIndex >= 0
			? getCompactionSummaryMetadata(messagesToSummarize[latestSummaryIndex])
					?.summary
			: undefined;
	const newMessagesToFold =
		latestSummaryIndex >= 0
			? messagesToSummarize.slice(latestSummaryIndex + 1)
			: messagesToSummarize;
	if (newMessagesToFold.length === 0 && !previousSummary) {
		return undefined;
	}

	const preProjectionFileOps = extractFileOps(messagesToSummarize);
	const summaryInfo =
		summarizerProviderConfig.modelInfo ??
		summarizerProviderConfig.knownModels?.[summarizerProviderConfig.modelId];
	if (
		typeof summaryInfo?.metadata?.inputTokenCountUrl === "string" ||
		(["vllm", "llamacpp"].includes(summarizerProviderConfig.providerId) &&
			summarizerProviderConfig.localInference?.inputTokenCounting !== false)
	) {
		const folded = messagesToSummarize.filter(
			(message) => message !== protectedPrompt,
		);
		const fileOps = extractFileOps(folded);
		const data = serializeConversation(folded);
		const checkpoint = await summarizeMeasuredChunks({
			providerConfig: summarizerProviderConfig,
			data,
			fileOps,
			signal: options.context.abortSignal ?? new AbortController().signal,
			logger: options.logger,
		});
		return {
			messages: [
				buildSummaryMessage({
					summary: checkpoint,
					fileOps,
					tokensBefore: options.context.budget.request.inputTokens,
					userRunSpan: countUserRunMessages(folded),
				}),
				...(protectedPrompt ? [protectedPrompt] : []),
				...messages.slice(cutIndex),
			],
		};
	}
	const resolvedSummarizerInputLimit = resolveProviderMaxInputTokens(
		summarizerProviderConfig,
	);
	const canUseActiveContextLimit = options.summarizer === undefined;
	const activeCompactionInputLimit = Math.max(
		options.context.budget.request.maxInputTokens,
		options.context.budget.request.triggerTokens,
		MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
	);
	if (resolvedSummarizerInputLimit === undefined && !canUseActiveContextLimit) {
		options.logger?.log(
			"Agentic compaction summarizer has no known input limit; using conservative summary budget",
			{
				severity: "warn",
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				fallbackInputLimit: MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
			},
		);
	}
	const summarizerInputLimit =
		resolvedSummarizerInputLimit ??
		(canUseActiveContextLimit
			? activeCompactionInputLimit
			: MIN_AGENTIC_SUMMARY_INPUT_TOKENS);
	const summaryRequestOverheadTokens = estimateTokens(
		buildSummaryRequest({
			previousSummary,
			conversationText: "",
			fileOps: preProjectionFileOps,
		}).length,
	);
	const availableSummaryInputTokens =
		summarizerInputLimit - summaryRequestOverheadTokens;
	if (availableSummaryInputTokens <= 0) {
		options.logger?.debug(
			"Skipped agentic compaction: summarizer budget exhausted",
			{
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				summarizerInputLimit,
				summaryRequestOverheadTokens,
			},
		);
		return undefined;
	}
	const summaryInputBudget = buildAgenticSummaryInputBudget({
		messages: newMessagesToFold,
		targetTokens: availableSummaryInputTokens,
		estimateMessageTokens: options.estimateMessageTokens,
	});
	if (summaryInputBudget.status === "failed") {
		options.logger?.log(
			"Skipped agentic compaction: summary input budget failed",
			{
				severity: "warn",
				budgetWarnings: summaryInputBudget.warnings.map(
					(warning) => warning.code,
				),
				summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
				targetTokens: availableSummaryInputTokens,
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
			},
		);
		return undefined;
	}
	const fileOps = extractFileOps(summaryInputBudget.messages);
	const conversationText = serializeConversation(summaryInputBudget.messages);
	const summaryRequest = buildSummaryRequest({
		previousSummary,
		conversationText,
		fileOps,
	});
	options.logger?.debug("Agentic compaction summarizer diagnostics", {
		messagesToSummarize: messagesToSummarize.length,
		newMessagesToFold: newMessagesToFold.length,
		preservedMessages: messages.length - cutIndex,
		previousSummaryChars: previousSummary?.length ?? 0,
		conversationTextChars: conversationText.length,
		summaryRequestChars: summaryRequest.length,
		summaryRequestEstimatedTokens: estimateTokens(summaryRequest.length),
		newMessagesJsonChars: safeJsonSize(newMessagesToFold),
		summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
		summaryInputActions: summaryInputBudget.actions.length,
		summaryInputWarnings: summaryInputBudget.warnings.map(
			(warning) => warning.code,
		),
		summaryRequestOverheadTokens,
		summarizerProviderId: summarizerProviderConfig.providerId,
		summarizerModelId: summarizerProviderConfig.modelId,
		summarizerInputLimit,
		maxInputTokens: options.context.budget.request.maxInputTokens,
		triggerTokens: options.context.budget.request.triggerTokens,
	});
	const summaryResult = await generateSummary({
		providerConfig: summarizerProviderConfig,
		systemPrompt:
			"Summarize the provided coding session into a concise continuation note with detailed next steps.",
		request: summaryRequest,
		logger: options.logger,
		signal: options.context.abortSignal,
	});
	options.logger?.debug("Generated compaction summary", {
		outputChars: summaryResult.text.length,
		reasoningChars: summaryResult.reasoningChars,
		incompleteReason: summaryResult.incompleteReason,
		modelId: summarizerProviderConfig.modelId,
		providerId: summarizerProviderConfig.providerId,
	});
	const rawSummary = summaryResult.text.trim();
	if (
		!rawSummary ||
		summaryResult.incompleteReason ||
		summaryResult.failed ||
		summaryResult.usedTools
	) {
		options.logger?.log(
			"Skipped agentic compaction: summarizer returned no summary text",
			{
				severity: "warn",
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				summarizerMaxOutputTokens: summarizerProviderConfig.maxOutputTokens,
				reasoningChars: summaryResult.reasoningChars,
				incompleteReason: summaryResult.incompleteReason,
				likelyCause:
					summaryResult.reasoningChars > 0
						? "output_budget_consumed_by_reasoning"
						: "empty_response",
			},
		);
		return undefined;
	}

	const summary = ensureFilesSection(rawSummary, fileOps);
	const tokensBefore = messages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	const resultMessages = [
		buildSummaryMessage({
			summary,
			fileOps,
			tokensBefore,
			userRunSpan: countUserRunMessages(
				messagesToSummarize.filter((message) => message !== protectedPrompt),
			),
		}),
		...(protectedPrompt ? [protectedPrompt] : []),
		...messages.slice(cutIndex),
	];
	const tokensAfter = resultMessages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	options.logger?.debug("Performed agentic compaction", {
		messagesBefore: messages.length,
		messagesAfter: resultMessages.length,
		messagesSummarized: cutIndex,
		messagesPreserved: messages.length - cutIndex,
		tokensBefore,
		tokensAfter,
		maxInputTokens: options.context.budget.request.maxInputTokens,
	});
	const budgetActionCount = summaryInputBudget.actions.filter(
		(action) =>
			action.reason === "over_budget" || action.reason === "tool_pair_boundary",
	).length;
	return {
		messages: resultMessages,
		budget: {
			policyIntent: "agentic_summary",
			actionCount: budgetActionCount,
			warningCount: summaryInputBudget.warnings.length,
			liveTailHandling: summaryInputBudget.liveTailHandling,
		},
	};
}
