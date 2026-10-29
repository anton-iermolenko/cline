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
	serializeMessage,
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

/** Keep messages and complete tool exchanges intact, including structured output. */
function summaryUnits(messages: CoreCompactionContext["messages"]): string[] {
	const units: string[] = [];
	const pendingCalls = new Set<string>();
	let exchange: string[] = [];
	for (const message of messages) {
		const text = serializeMessage(message, { preserveContent: true });
		if (text) exchange.push(text);
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "tool_use") pendingCalls.add(block.id);
				if (block.type === "tool_result")
					pendingCalls.delete(block.tool_use_id);
			}
		}
		if (pendingCalls.size === 0 && exchange.length) {
			units.push(exchange.join("\n\n"));
			exchange = [];
		}
	}
	if (exchange.length) units.push(exchange.join("\n\n"));
	return units;
}

async function summarizeMeasuredChunks(options: {
	providerConfig: ProviderConfig;
	messages: CoreCompactionContext["messages"];
	fileOps: ReturnType<typeof extractFileOps>;
	summaryTokens: number;
	signal: AbortSignal;
	logger?: BasicLogger;
}): Promise<string> {
	const instruction =
		"Write factual continuation notes for this coding session. Preserve useful details, decisions, user corrections and observed tool outcomes. Do not shorten them into a brief overview.";
	const makeCounter = (continueAssistantMessage = false) =>
		createAgentModelFromConfig(
			{
				providerId: options.providerConfig.providerId,
				modelId: options.providerConfig.modelId,
				providerConfig: { ...options.providerConfig, continueAssistantMessage },
				systemPrompt: instruction,
				tools: [],
			},
			undefined,
		);
	const counter = makeCounter();
	const prefillCounter =
		options.providerConfig.providerId === "vllm"
			? makeCounter(true)
			: undefined;
	let inputAllowance: number | undefined;
	const count = async (text: string, assistantPrefill?: string) => {
		options.signal.throwIfAborted();
		const activeCounter = assistantPrefill ? prefillCounter : counter;
		if (!activeCounter)
			throw new Error("Assistant prefill counter is unavailable");
		const measured = await activeCounter.countInputTokens?.({
			systemPrompt: instruction,
			messages: [
				{
					id: "summary-count",
					createdAt: 0,
					role: "user",
					content: [{ type: "text", text }],
				},
				...(assistantPrefill
					? [
							{
								id: "summary-prefill",
								createdAt: 0,
								role: "assistant" as const,
								content: [{ type: "text" as const, text: assistantPrefill }],
							},
						]
					: []),
			],
			tools: [],
			signal: options.signal,
			options: {
				maxTokens: options.providerConfig.maxOutputTokens,
				thinking: false,
			},
		});
		options.signal.throwIfAborted();
		if (!measured)
			throw new Error(
				"Summarizer input token counting unavailable; original context was preserved",
			);
		if (
			inputAllowance !== undefined &&
			measured.maxInputTokens !== inputAllowance
		)
			throw new Error(
				"Summarizer input allowance changed; original context was preserved",
			);
		inputAllowance = measured.maxInputTokens;
		return measured;
	};
	const empty = await count("");
	const batchInputTokens = Math.max(1, Math.floor(empty.maxInputTokens * 0.4));
	const generate = async (request: string, assistantPrefill?: string) => {
		options.signal.throwIfAborted();
		const result = await generateSummary({
			providerConfig: {
				...options.providerConfig,
				abortSignal: options.signal,
			},
			systemPrompt: instruction,
			signal: options.signal,
			request,
			assistantPrefill,
			logger: options.logger,
		});
		if (
			!result.text.trim() ||
			result.incompleteReason ||
			result.failed ||
			result.usedTools
		)
			throw new Error(
				"Summarizer returned an empty or incomplete checkpoint; original context was preserved",
			);
		return result.text.trim();
	};
	const units = summaryUnits(options.messages);
	const notes: string[] = [];
	let position = 0;
	while (position < units.length) {
		if (notes.length >= 64)
			throw new Error(
				"Compaction exceeded the bounded summary segment limit; original context was preserved",
			);
		const additionHeading =
			prefillCounter && notes.length
				? "## Summary of the next historical batch\n"
				: "";
		const assistantPrefill = additionHeading
			? notes.join("\n\n") + "\n\n" + additionHeading
			: undefined;
		const requestFor = (end: number) =>
			buildSummaryRequest({
				previousSummary: notes.join("\n\n"),
				conversationText: units.slice(position, end).join("\n\n"),
				fileOps: options.fileOps,
				append: notes.length > 0,
				summaryTokens: options.summaryTokens,
				assistantPrefill: assistantPrefill !== undefined,
			});
		let end = position + 1;
		let request = requestFor(end);
		let measured = await count(request, assistantPrefill);
		if (measured.inputTokens > measured.maxInputTokens)
			throw new Error(
				"An intact message/tool exchange and accumulated summary exceed the summarizer input allowance; original context was preserved",
			);
		// The 40% batch size is a preference. One oversized exchange remains
		// whole when it fits the real input allowance.
		if (measured.inputTokens <= batchInputTokens) {
			let low = end,
				high = units.length;
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				const candidate = requestFor(middle);
				const candidateCount = await count(candidate, assistantPrefill);
				if (candidateCount.inputTokens <= batchInputTokens) {
					low = middle;
					request = candidate;
					measured = candidateCount;
				} else high = middle - 1;
			}
			end = low;
		}
		const addition = await generate(request, assistantPrefill);
		notes.push(additionHeading + addition);
		options.logger?.log("Compaction summary batch completed", {
			batch: notes.length,
			assistantPrefill: assistantPrefill !== undefined,
			inputTokens: measured.inputTokens,
			batchInputTokens,
			units: end - position,
			additionChars: addition.length,
			accumulatedChars: notes.join("\n\n").length,
		});
		position = end;
	}
	let checkpoint = ensureFilesSection(notes.join("\n\n"), options.fileOps);
	// The model gets a character-size instruction; the tokenizer enforces the
	// actual quota. Notes below quota are never rewritten just to be shorter.
	for (let attempt = 0; attempt < 4; attempt++) {
		const measured = await count(`Context summary:\n\n${checkpoint}`);
		const summaryTokens = Math.max(0, measured.inputTokens - empty.inputTokens);
		if (summaryTokens <= options.summaryTokens) {
			options.logger?.log("Compaction summary quota verified", {
				summaryTokens,
				summaryQuotaTokens: options.summaryTokens,
				batches: notes.length,
				compressionPasses: attempt,
			});
			return checkpoint;
		}
		if (attempt === 3) break;
		const targetChars = Math.max(
			1,
			Math.floor(
				((checkpoint.length * options.summaryTokens) / summaryTokens) * 0.85,
			),
		);
		const request = `Compress the complete continuation notes below to at most ${targetChars} characters (the hard allowance is ${options.summaryTokens} tokens). Preserve user requirements and corrections, confirmed changes, exact paths and identifiers, important tool evidence, unresolved issues and actual next steps. Reconcile contradictions using the latest evidence. Return only the compressed notes.\n\n${checkpoint}`;
		const compressionCount = await count(request);
		if (compressionCount.inputTokens > compressionCount.maxInputTokens)
			throw new Error(
				"Accumulated summary exceeds the compression input allowance; original context was preserved",
			);
		checkpoint = ensureFilesSection(await generate(request), options.fileOps);
	}
	throw new Error(
		"Compaction summary could not fit its token quota; original context was preserved",
	);
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
	let cutIndex = findCutIndex(
		messages,
		preserveRecentTokens,
		options.estimateMessageTokens,
	);
	let protectedPromptTokens = 0;
	for (;;) {
		const reserved = messages
			.slice(0, cutIndex)
			.filter(isTurnStartMessage)
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

	const messagesToSummarize = messages.slice(0, cutIndex);
	const protectedPrompts = messagesToSummarize.filter(isTurnStartMessage);
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
			messages: folded,
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
						folded.filter((message) => !isTurnStartMessage(message)),
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
				messagesToSummarize.filter((message) => !isTurnStartMessage(message)),
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
