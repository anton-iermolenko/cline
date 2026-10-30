import type { BasicLogger } from "@cline/shared";
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
import { summarizeMeasuredChunks } from "./measured-summary";
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
		summaryTokens: options.context.budget.request.summaryTokens,
	});
	// Retain history toward the preferred full-request size, rather than a
	// fixed 20K suffix. The caller has removed request overhead and clamped
	// this message budget to the configured maximum and live input allowance.
	const summaryReserveTokens =
		options.context.budget.request.summaryTokens ??
		summarizerProviderConfig.maxOutputTokens ??
		DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS;
	let preserveRecentTokens = Math.max(
		0,
		Math.min(
			options.preserveRecentTokens ?? Number.POSITIVE_INFINITY,
			options.context.budget.messages.targetTokens - summaryReserveTokens,
		),
	);
	// Older human messages are summarized in place with their replies. Only the
	// latest instruction is reinserted if the cut reaches into its active turn.
	const latestPrompt = [...messages].reverse().find(isTurnStartMessage);
	let cutIndex = findCutIndex(
		messages,
		preserveRecentTokens,
		options.estimateMessageTokens,
	);
	let protectedPromptTokens = 0;
	for (;;) {
		const reserved = messages
			.slice(0, cutIndex)
			.filter((message) => message === latestPrompt)
			.reduce(
				(total, message) => total + options.estimateMessageTokens(message),
				0,
			);
		if (reserved === protectedPromptTokens) break;
		protectedPromptTokens = reserved;
		const next = findCutIndex(
			messages,
			Math.max(0, preserveRecentTokens - protectedPromptTokens),
			options.estimateMessageTokens,
		);
		if (next === cutIndex) break;
		cutIndex = next;
	}
	preserveRecentTokens = Math.max(
		0,
		preserveRecentTokens - protectedPromptTokens,
	);
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

	// Reserve the summary against the actual retained request. Calibrated per-message
	// estimates can still miss delimiter/role costs and reject an otherwise useful checkpoint.
	if (options.context.countRequestInputTokens) {
		const countRetained = options.context.countRequestInputTokens;
		const fits = async (cut: number) => {
			options.context.abortSignal?.throwIfAborted();
			const folded = messages.slice(0, cut);
			const measured = await countRetained([
				buildSummaryMessage({
					summary: "",
					fileOps: extractFileOps(folded),
					tokensBefore: options.context.budget.request.inputTokens,
					userRunSpan: countUserRunMessages(
						folded.filter((message) => message !== latestPrompt),
					),
				}),
				...folded.filter((message) => message === latestPrompt),
				...messages.slice(cut),
			]);
			options.context.abortSignal?.throwIfAborted();
			if (!measured)
				throw new Error(
					"Input token counter became unavailable; original context was preserved",
				);
			return (
				measured.inputTokens + summaryReserveTokens + 32 <=
				Math.min(
					options.context.budget.request.targetTokens,
					measured.maxInputTokens,
				)
			);
		};
		if (!(await fits(cutIndex))) {
			let low = 0,
				high = preserveRecentTokens,
				best: number | undefined;
			while (low <= high) {
				const middle = Math.floor((low + high) / 2);
				const cut = findCutIndex(
					messages,
					middle,
					options.estimateMessageTokens,
				);
				if (cut > 0 && cut < messages.length && (await fits(cut))) {
					best = cut;
					low = middle + 1;
				} else high = middle - 1;
			}
			if (best !== undefined) cutIndex = best;
			// If the full reservation cannot fit, final measured admission remains authoritative.
		}
	}

	const messagesToSummarize = messages.slice(0, cutIndex);
	const protectedPrompts = messagesToSummarize.filter(
		(message) => message === latestPrompt,
	);
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
		const folded = messagesToSummarize;
		const fileOps = extractFileOps(folded);
		const checkpoint = await summarizeMeasuredChunks({
			providerConfig: summarizerProviderConfig,
			messages: newMessagesToFold,
			previousSummary,
			summaryTokens: summaryReserveTokens,
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
					userRunSpan: countUserRunMessages(
						folded.filter((message) => message !== latestPrompt),
					),
				}),
				...protectedPrompts,
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
				messagesToSummarize.filter((message) => message !== latestPrompt),
			),
		}),
		...protectedPrompts,
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
