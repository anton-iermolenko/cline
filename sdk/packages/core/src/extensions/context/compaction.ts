import {
	DEFAULT_COMPACTION_BUFFER_TOKENS,
	estimateRequestInputTokens,
	type RequestInputTokenCount,
	resolveAutoCompactionTargetTokens,
} from "@cline/shared";
import { messagesToAgentMessages } from "../../runtime/config/agent-message-codec";
import {
	createAgentModelFromConfig,
	resolveConnectionProviderConfig,
	resolveKnownModelsFromConfig,
} from "../../services/llms/handler-factory";
import {
	captureCompactionBudgetEmergency,
	captureCompactionExecuted,
	captureCompactionSkipped,
	type TelemetryCompactionStrategy,
} from "../../services/telemetry/core-events";
import {
	createSessionCompactionState,
	projectSessionCompactionState,
	type SessionCompactionState,
} from "../../session/models/session-compaction";
import {
	getMessageBuilderOptionsFromEnv,
	MessageBuilder,
} from "../../session/services/message-builder";
import type {
	CoreCompactionConfig,
	CoreCompactionContext,
	CoreCompactionMode,
	CoreCompactionResult,
	CoreCompactionStrategy,
	CoreSessionConfig,
} from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import { runAgenticCompaction } from "./agentic-compaction";
import { runBasicCompaction } from "./basic-compaction";
import {
	COMPACTION_TRIGGER_RATIO,
	createTokenEstimator,
	DEFAULT_MAX_INPUT_TOKENS,
	findLatestSummaryIndex,
	isTurnStartMessage,
	MAX_INPUT_UNDERESTIMATE_FACTOR,
	resolveEffectiveMaxInputTokens,
} from "./compaction-shared";
import { createMeasuredImageTokenEstimator } from "./image-token-accounting";

export interface ContextPipelinePrepareTurnInput {
	agentId: string;
	conversationId: string;
	parentAgentId: string | null;
	iteration: number;
	messages: CoreCompactionContext["messages"];
	apiMessages: CoreCompactionContext["messages"];
	countRequestInputTokens?: (
		messages: CoreCompactionContext["messages"],
		systemPrompt?: string,
	) => Promise<RequestInputTokenCount | undefined>;
	abortSignal: AbortSignal;
	systemPrompt: string;
	tools: unknown[];
	model: CoreCompactionContext["model"];
	/**
	 * Set by the runtime when the provider rejected the previous request as
	 * exceeding the model's context window. Forces a compaction regardless of
	 * the token-estimate trigger (the estimate just proved wrong) and uses the
	 * deterministic basic strategy — recovery must not depend on another
	 * successful LLM request.
	 */
	overflowRecovery?: boolean;
	/**
	 * Actual provider-reported input tokens for the previous request this run,
	 * used as a floor on the char-based estimate so dense content still triggers
	 * compaction. See AgentPrepareTurnContext.previousRequestInputTokens.
	 */
	previousRequestInputTokens?: number;
	emitStatusNotice?: (
		message: string,
		metadata?: Record<string, unknown>,
	) => void;
}

export interface ContextPipelinePrepareTurnResult {
	messages: CoreCompactionContext["messages"];
	systemPrompt?: string;
}

export type ContextPipelinePrepareTurn = (
	context: ContextPipelinePrepareTurnInput,
) => Promise<ContextPipelinePrepareTurnResult | undefined>;

type EstimateMessageTokens = ReturnType<typeof createTokenEstimator>;

type BuiltinCompactionStrategyOptions = {
	context: CoreCompactionContext;
	providerConfig: ProviderConfig;
	compaction: CoreCompactionConfig | undefined;
	estimateMessageTokens: EstimateMessageTokens;
	logger: Pick<CoreSessionConfig, "logger">["logger"];
};

type BuiltinCompactionStrategyRunner = (
	options: BuiltinCompactionStrategyOptions,
) =>
	| Promise<CoreCompactionResult | undefined>
	| CoreCompactionResult
	| undefined;

export interface ContextCompactionPrepareTurnOptions {
	mode?: CoreCompactionMode;
	manualTargetRatio?: number;
	/** Overrides layered over `config.compaction`. */
	compaction?: Partial<CoreCompactionConfig>;
}

function isCompactionCancellation(
	error: unknown,
	abortSignal: AbortSignal,
): boolean {
	if (abortSignal.aborted) {
		return true;
	}
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "AgentRuntimeAbortError")
	);
}

function describeCompactionError(error: unknown): Record<string, unknown> {
	return error instanceof Error
		? { errorName: error.name, errorMessage: error.message }
		: { errorMessage: String(error) };
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function summarizeToolResults(messages: CoreCompactionContext["messages"]): {
	toolResultCount: number;
	toolResultSerializedChars: number;
	maxToolResultSerializedChars: number;
} {
	let toolResultCount = 0;
	let toolResultSerializedChars = 0;
	let maxToolResultSerializedChars = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type !== "tool_result") {
				continue;
			}
			const size = safeJsonSize(block.content);
			toolResultCount += 1;
			toolResultSerializedChars += size;
			maxToolResultSerializedChars = Math.max(
				maxToolResultSerializedChars,
				size,
			);
		}
	}
	return {
		toolResultCount,
		toolResultSerializedChars,
		maxToolResultSerializedChars,
	};
}

const BUILTIN_COMPACTION_STRATEGIES = {
	basic: ({ context, estimateMessageTokens, logger }) =>
		runBasicCompaction({
			context,
			estimateMessageTokens,
			logger,
		}),
	agentic: ({
		context,
		providerConfig,
		compaction,
		estimateMessageTokens,
		logger,
	}) =>
		runAgenticCompaction({
			context,
			providerConfig,
			summarizer: compaction?.summarizer,
			preserveRecentTokens: compaction?.preserveRecentTokens,
			estimateMessageTokens,
			logger,
		}),
} satisfies Record<CoreCompactionStrategy, BuiltinCompactionStrategyRunner>;

function resolveManualMessageTargetTokens(input: {
	messageInputTokens: number;
	messageTriggerTokens: number;
	manualTargetRatio: number | undefined;
}): number {
	const ratio =
		typeof input.manualTargetRatio === "number" &&
		Number.isFinite(input.manualTargetRatio)
			? input.manualTargetRatio
			: 0.5;
	const targetRatio = Math.min(0.95, Math.max(0.05, ratio));
	return Math.max(
		1,
		Math.floor(
			Math.min(
				input.messageTriggerTokens,
				input.messageInputTokens * targetRatio,
			),
		),
	);
}

function translateRequestBudgetToMessages(
	requestTokens: number,
	overheadTokens: number,
): number {
	return Math.max(1, Math.floor(requestTokens - overheadTokens));
}

function countUserAssistantPairs(
	messages: CoreCompactionContext["messages"],
): number {
	let pairs = 0;
	let hasPendingUser = false;
	for (const message of messages) {
		if (message.role === "user") {
			hasPendingUser = true;
		} else if (message.role === "assistant" && hasPendingUser) {
			pairs += 1;
			hasPendingUser = false;
		}
	}
	return pairs;
}

/**
 * Build the `prepareTurn` callback used by the agent runtime to compact the
 * transcript before each model request.
 *
 * Telemetry: emits `task.compaction_executed` on a successful compaction and
 * `task.compaction_skipped` when the configured strategy returns `undefined`.
 * Telemetry is keyed by `config.sessionId` (falling back to the per-turn
 * `conversationId`) and tagged with `provider` / `modelId`.
 *
 * Known gap: compactions performed via plugin `registerMessageBuilder()` or
 * via the `beforeModel` runtime hook bypass this wrapper entirely, so they
 * do not emit compaction telemetry. If we want coverage there too, the
 * plugin/hook pipelines must be instrumented separately.
 */
export function createContextCompactionPrepareTurn(
	config: Pick<
		CoreSessionConfig,
		| "providerConfig"
		| "providerId"
		| "modelId"
		| "apiKey"
		| "baseUrl"
		| "headers"
		| "compaction"
		| "logger"
		| "telemetry"
		| "sessionId"
	>,
	options: ContextCompactionPrepareTurnOptions = {},
):
	| ((
			context: ContextPipelinePrepareTurnInput,
	  ) => Promise<ContextPipelinePrepareTurnResult | undefined>)
	| undefined {
	const userCompaction: CoreCompactionConfig = {
		...config.compaction,
		...(
			config.providerConfig as
				| { localInference?: import("@cline/shared").LocalInferenceSettings }
				| undefined
		)?.localInference?.compaction,
		...options.compaction,
	};
	if (userCompaction.enabled !== true) {
		return undefined;
	}

	const baseEstimateMessageTokens = createTokenEstimator();
	const irreducibleRequests = new Set<string>();
	const strategy = userCompaction?.strategy ?? "agentic";
	const runBuiltinStrategy = BUILTIN_COMPACTION_STRATEGIES[strategy];
	const mode = options.mode ?? "auto";
	const telemetryStrategy: TelemetryCompactionStrategy = userCompaction?.compact
		? "custom"
		: strategy;

	return async (context) => {
		context.abortSignal.throwIfAborted();
		const effectiveMode: CoreCompactionMode = context.overflowRecovery
			? "overflow_recovery"
			: mode;
		const countRequest =
			context.countRequestInputTokens ??
			(typeof context.model.info?.metadata?.inputTokenCountUrl !== "string" &&
			!["vllm", "llamacpp"].includes(
				context.model.provider ?? config.providerId ?? "",
			)
				? async () => undefined
				: async (
						messages: CoreCompactionContext["messages"],
						systemPrompt = context.systemPrompt,
					) => {
						const model = createAgentModelFromConfig(
							{
								...config,
								systemPrompt: context.systemPrompt,
								tools: [],
								providerConfig: resolveConnectionProviderConfig(config),
							},
							undefined,
						);
						return model.countInputTokens?.({
							systemPrompt,
							messages: messagesToAgentMessages(
								new MessageBuilder(
									getMessageBuilderOptionsFromEnv(),
								).buildPreviewForApi(messages),
							),
							tools: context.tools as never,
							signal: context.abortSignal,
							options: {
								maxTokens: config.providerConfig?.maxOutputTokens,
								thinking: config.providerConfig?.thinking,
								reasoningEffort: config.providerConfig?.reasoningEffort,
								thinkingBudgetTokens:
									config.providerConfig?.thinkingBudgetTokens,
							},
						});
					});
		const beforeMeasurement = await countRequest(context.messages);
		context.abortSignal.throwIfAborted();
		const estimatedRequestTokens = estimateRequestInputTokens({
			systemPrompt: context.systemPrompt,
			messages: context.apiMessages,
			tools: context.tools,
		});
		const requestInputTokens =
			beforeMeasurement?.inputTokens ?? estimatedRequestTokens;
		const buffer =
			userCompaction.bufferTokens ??
			beforeMeasurement?.compactionBufferTokens ??
			DEFAULT_COMPACTION_BUFFER_TOKENS;
		if (!Number.isSafeInteger(buffer) || buffer < 0)
			throw new Error("Compaction bufferTokens must be a nonnegative integer");
		const countScale = beforeMeasurement
			? requestInputTokens / Math.max(1, estimatedRequestTokens)
			: 1;
		// Native vision costs replace serialized base64 estimates only when a
		// compaction will actually run. Normal turns do not add calibration calls.
		const imageEstimator =
			beforeMeasurement &&
			(effectiveMode !== "auto" ||
				requestInputTokens >= beforeMeasurement.maxInputTokens - buffer)
				? await createMeasuredImageTokenEstimator({
						messages: context.messages,
						apiMessages: context.apiMessages,
						systemPrompt: context.systemPrompt,
						tools: context.tools,
						measurement: beforeMeasurement,
						countRequest,
						baseEstimateMessageTokens,
						signal: context.abortSignal,
						logger: config.logger,
					})
				: undefined;
		const estimateMessageTokens =
			imageEstimator ??
			((message: CoreCompactionContext["messages"][number]) =>
				Math.max(
					1,
					Math.ceil(baseEstimateMessageTokens(message) * countScale),
				));
		const apiMessageTokens = context.apiMessages.reduce(
			(total, message) => total + estimateMessageTokens(message),
			0,
		);
		const messageInputTokens = context.messages.reduce(
			(total, message) => total + estimateMessageTokens(message),
			0,
		);
		const requestOverheadTokens = Math.max(
			0,
			requestInputTokens - apiMessageTokens,
		);
		const modelMaxInputTokens =
			beforeMeasurement?.maxInputTokens ??
			resolveEffectiveMaxInputTokens({
				maxInputTokens: context.model.info?.maxInputTokens,
				contextWindow: context.model.info?.contextWindow,
				maxOutputTokens: config.providerConfig?.maxOutputTokens,
			});
		// Unknown limits do not justify automatic compaction. Manual/overflow
		// recovery retains its conservative working budget.
		if (effectiveMode === "auto" && modelMaxInputTokens === undefined)
			return undefined;
		const rawMaxInputTokens = modelMaxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
		// The char-based estimate under-counts dense content (disassembly, image
		// dumps, minified sources). When the provider's actual count for the
		// PREVIOUS request already exceeds our estimate for the (larger) current
		// transcript, the estimator is demonstrably under-counting, so scale the
		// whole budget down by that ratio. Scaling the budget rather than just the
		// trigger keeps every downstream number — trigger, target and the
		// projection's message costs — in the same estimate units while still
		// corresponding to the provider's real limit; raising only the trigger
		// would start a compaction that then retains too much and still overflows.
		//
		// Deliberately conservative: it never loosens the budget, engages only on
		// direct evidence of under-counting, and is capped so a tiny estimate
		// cannot collapse the budget.
		const actualPreviousInputTokens =
			typeof context.previousRequestInputTokens === "number" &&
			context.previousRequestInputTokens > 0
				? context.previousRequestInputTokens
				: 0;
		const underestimateFactor =
			!beforeMeasurement &&
			actualPreviousInputTokens > 0 &&
			requestInputTokens > 0
				? Math.min(
						MAX_INPUT_UNDERESTIMATE_FACTOR,
						Math.max(1, actualPreviousInputTokens / requestInputTokens),
					)
				: 1;
		const maxInputTokens = rawMaxInputTokens / underestimateFactor;
		for (const [name, value] of Object.entries({
			maxTargetTokens: userCompaction.maxTargetTokens,
			targetTokens: userCompaction.targetTokens,
		})) {
			if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
				throw new Error(`Compaction ${name} must be a positive integer`);
		}
		if (
			userCompaction.maxTargetTokens !== undefined &&
			userCompaction.targetTokens !== undefined &&
			userCompaction.targetTokens > userCompaction.maxTargetTokens
		)
			throw new Error(
				"Compaction targetTokens must not exceed maxTargetTokens",
			);
		const requestTriggerTokens = beforeMeasurement
			? Math.max(1, maxInputTokens - buffer)
			: maxInputTokens * COMPACTION_TRIGGER_RATIO;
		if (beforeMeasurement)
			context.emitStatusNotice?.("input-token-count", {
				kind: "input_token_count",
				...beforeMeasurement,
				triggerTokens: requestTriggerTokens,
			});
		if (
			effectiveMode === "auto" &&
			beforeMeasurement &&
			requestInputTokens <= maxInputTokens &&
			irreducibleRequests.has(
				beforeMeasurement.fingerprint + beforeMeasurement.budgetRevision,
			)
		)
			return undefined;
		const messageTriggerTokens = translateRequestBudgetToMessages(
			requestTriggerTokens,
			requestOverheadTokens,
		);
		// Equivalent to comparing the provider's actual count against the unscaled
		// trigger, because the budget above already carries the ratio.
		const shouldCompact = requestInputTokens >= requestTriggerTokens;
		config.logger?.debug("Context compaction diagnostics", {
			mode: effectiveMode,
			strategy,
			iteration: context.iteration,
			providerId: config.providerId,
			modelId: config.modelId,
			requestInputTokens,
			apiMessageTokens,
			messageInputTokens,
			requestOverheadTokens,
			maxInputTokens,
			rawMaxInputTokens,
			actualPreviousInputTokens,
			underestimateFactor,
			requestTriggerTokens,
			messageTriggerTokens,
			thresholdRatio: requestTriggerTokens / maxInputTokens,
			shouldCompact,
			messageCount: context.messages.length,
			apiMessageCount: context.apiMessages.length,
			apiMessagesJsonChars: safeJsonSize(context.apiMessages),
			...summarizeToolResults(context.apiMessages),
		});
		if (effectiveMode === "auto" && !shouldCompact) {
			return undefined;
		}
		let requestTargetTokens: number;
		let messageTargetTokens: number;
		if (effectiveMode === "auto") {
			requestTargetTokens = resolveAutoCompactionTargetTokens({
				maxInputTokens,
				modelMaxTokens: context.model.info?.maxTokens,
				triggerTokens: requestTriggerTokens,
				messagePairCount: countUserAssistantPairs(context.messages),
			});
			if (userCompaction.targetTokens !== undefined)
				requestTargetTokens = Math.max(
					1,
					Math.min(
						Math.floor(userCompaction.targetTokens / underestimateFactor),
						requestTriggerTokens - 1,
					),
				);
			messageTargetTokens = translateRequestBudgetToMessages(
				requestTargetTokens,
				requestOverheadTokens,
			);
		} else {
			messageTargetTokens = resolveManualMessageTargetTokens({
				messageInputTokens,
				messageTriggerTokens,
				manualTargetRatio: options.manualTargetRatio,
			});
			requestTargetTokens = requestOverheadTokens + messageTargetTokens;
			if (
				effectiveMode === "overflow_recovery" &&
				userCompaction.targetTokens !== undefined
			) {
				requestTargetTokens = Math.max(
					1,
					Math.min(
						Math.floor(userCompaction.targetTokens / underestimateFactor),
						requestTriggerTokens - 1,
					),
				);
				messageTargetTokens = translateRequestBudgetToMessages(
					requestTargetTokens,
					requestOverheadTokens,
				);
			}
		}

		// The maximum bounds every compacted request, including default/manual
		// targets. The message budget already excludes system/tool overhead.
		const maxResultTokens =
			userCompaction.maxTargetTokens === undefined
				? undefined
				: Math.max(
						1,
						Math.floor(userCompaction.maxTargetTokens / underestimateFactor),
					);
		if (maxResultTokens !== undefined) {
			requestTargetTokens = Math.min(requestTargetTokens, maxResultTokens);
			messageTargetTokens = translateRequestBudgetToMessages(
				requestTargetTokens,
				requestOverheadTokens,
			);
		}

		const compactionContext = {
			agentId: context.agentId,
			conversationId: context.conversationId,
			parentAgentId: context.parentAgentId,
			iteration: context.iteration,
			messages: context.messages,
			model: context.model,
			mode: effectiveMode,
			abortSignal: context.abortSignal,
			budget: {
				request: {
					inputTokens: requestInputTokens,
					maxInputTokens,
					triggerTokens: requestTriggerTokens,
					targetTokens: requestTargetTokens,
					overheadTokens: requestOverheadTokens,
					thresholdRatio: requestTriggerTokens / maxInputTokens,
					utilizationRatio:
						maxInputTokens > 0 ? requestInputTokens / maxInputTokens : 0,
				},
				messages: {
					inputTokens: messageInputTokens,
					triggerTokens: messageTriggerTokens,
					targetTokens: messageTargetTokens,
				},
			},
		};

		const statusReason =
			effectiveMode === "manual"
				? "manual_compaction"
				: effectiveMode === "overflow_recovery"
					? "overflow_recovery_compaction"
					: "auto_compaction";
		const noticePrefix =
			effectiveMode === "manual"
				? ""
				: effectiveMode === "overflow_recovery"
					? "overflow-recovery-"
					: "auto-";
		context.emitStatusNotice?.(`${noticePrefix}compacting`, {
			kind: statusReason,
			reason: statusReason,
			phase: "started",
			iteration: context.iteration,
			triggerTokens: requestTriggerTokens,
			targetTokens: requestTargetTokens,
			maxInputTokens,
			messageTargetTokens,
		});

		const beforeMessageCount = context.messages.length;
		const startedAt = Date.now();

		const builtinOptions = {
			context: compactionContext,
			// Resolved per turn from the live session config, with the same
			// precedence as the main request, so the summarizer never sends
			// credentials the host has since refreshed or replaced.
			providerConfig: {
				...resolveConnectionProviderConfig(config),
				knownModels: resolveKnownModelsFromConfig({
					...config,
					systemPrompt: context.systemPrompt,
					tools: [],
					knownModels: context.model.info
						? { [config.modelId]: context.model.info }
						: undefined,
				}),
				abortSignal: context.abortSignal,
			},
			compaction: userCompaction,
			estimateMessageTokens,
			logger: config.logger,
		};
		let executedStrategy = telemetryStrategy;
		let result: CoreCompactionResult | undefined;
		if (effectiveMode === "overflow_recovery") {
			// The provider already rejected the request, so recovery must end
			// deterministically: the agentic strategy's own summarizer call could
			// overflow the same window (its input budgeting trusts the same
			// estimator that just undercounted). A custom compactor gets first
			// shot — it sees mode "overflow_recovery" and owns its transcript
			// invariants — but its result is held to the same bar basic
			// compaction aims for: strictly smaller than the input (the runtime
			// refuses to retry with a request that is not smaller) AND within
			// the recovery token target. A marginal shrink would spend the
			// run's single retry on a request that still cannot fit. On throw,
			// decline, or an insufficient result, basic compaction runs so
			// recovery never depends on another successful LLM request.
			if (userCompaction?.compact) {
				try {
					result = await userCompaction.compact(compactionContext);
				} catch (error) {
					if (isCompactionCancellation(error, context.abortSignal)) {
						throw error;
					}
					config.logger?.log(
						"Custom compaction failed during overflow recovery; falling back to basic compaction",
						{
							severity: "warn",
							...describeCompactionError(error),
						},
					);
					result = undefined;
				}
				if (result?.messages) {
					const customMessageTokens = result.messages.reduce(
						(total: number, message) => total + estimateMessageTokens(message),
						0,
					);
					// The full acceptance bar, covering every degenerate size: a
					// non-empty transcript (an empty one erases the request being
					// retried), strictly smaller than the input (the runtime
					// refuses a retry that is not smaller), and within the
					// recovery token target (a marginal shrink spends the run's
					// single retry on a request that still cannot fit). Both size
					// comparisons use the token estimator rather than serialized
					// length so they are expressed in the same unit as the target.
					const acceptable =
						result.messages.length > 0 &&
						customMessageTokens < messageInputTokens &&
						customMessageTokens <= messageTargetTokens;
					if (!acceptable) {
						config.logger?.log(
							"Custom compaction did not produce an acceptable overflow-recovery transcript; falling back to basic compaction",
							{
								severity: "warn",
								customMessageCount: result.messages.length,
								customMessageTokens,
								messageTargetTokens,
							},
						);
						result = undefined;
					}
				}
			}
			if (!result?.messages) {
				executedStrategy = "basic";
				result = await BUILTIN_COMPACTION_STRATEGIES.basic(builtinOptions);
			}
		} else if (userCompaction?.compact) {
			result = await userCompaction.compact(compactionContext);
		} else {
			try {
				result = await runBuiltinStrategy(builtinOptions);
			} catch (error) {
				if (
					strategy !== "agentic" ||
					isCompactionCancellation(error, context.abortSignal)
				) {
					throw error;
				}
				config.logger?.log(
					"Agentic compaction failed; falling back to basic compaction",
					{
						severity: "warn",
						...describeCompactionError(error),
					},
				);
				executedStrategy = "basic";
				result = await BUILTIN_COMPACTION_STRATEGIES.basic(builtinOptions);
			}
		}

		// A declined summary is not a reason to send the same oversized request.
		// Retry with a deterministic fold, including previously preserved output.
		if (
			!beforeMeasurement &&
			!userCompaction?.compact &&
			(effectiveMode === "auto" ||
				(effectiveMode === "manual" &&
					requestInputTokens >= requestTriggerTokens))
		) {
			const resultTokens = result?.messages?.reduce(
				(total, message) => total + estimateMessageTokens(message),
				0,
			);
			if (
				resultTokens === undefined ||
				resultTokens >
					(effectiveMode === "manual"
						? messageTriggerTokens
						: messageTargetTokens) ||
				resultTokens >= messageInputTokens
			) {
				context.abortSignal.throwIfAborted();
				config.logger?.log(
					"Compaction returned no usable bounded context; retrying basic fold",
					{
						severity: "warn",
						mode: effectiveMode,
						strategy: executedStrategy,
						reason: resultTokens === undefined ? "no_result" : "over_target",
						resultTokens,
						messageInputTokens,
						messageTargetTokens,
						maxInputTokens,
					},
				);
				executedStrategy = "basic";
				result = runBasicCompaction({
					context: compactionContext,
					estimateMessageTokens,
					logger: config.logger,
					refoldPreserved: true,
				});
			}
			const finalTokens = result?.messages?.reduce(
				(total, message) => total + estimateMessageTokens(message),
				0,
			);
			if (
				!result?.messages?.length ||
				finalTokens === undefined ||
				finalTokens + requestOverheadTokens >= requestTriggerTokens
			) {
				const reason =
					!result?.messages?.length || finalTokens === undefined
						? "no_usable_result"
						: "result_over_threshold";
				config.logger?.log("Compaction could not produce bounded context", {
					severity: "warn",
					mode: effectiveMode,
					reason,
					messageInputTokens,
					finalMessageTokens: finalTokens,
					requestOverheadTokens,
					requestTriggerTokens,
					maxInputTokens,
				});
				throw new Error(
					`Compaction cannot fit the request below the compaction threshold (${Math.floor(requestTriggerTokens)} tokens; input allowance ${Math.floor(maxInputTokens)} tokens). ` +
						(reason === "no_usable_result"
							? "The fallback returned no usable context; this does not establish that the protected prompt is too large. "
							: `Remaining message estimate: ${finalTokens} tokens; request overhead: ${requestOverheadTokens} tokens. `) +
						"Reduce retained context or request overhead before retrying.",
				);
			}
		}

		let afterMeasurement: RequestInputTokenCount | undefined;
		if (beforeMeasurement) {
			const measure = async (candidate: CoreCompactionResult | undefined) =>
				candidate?.messages?.length
					? await countRequest(
							candidate.messages,
							candidate.systemPrompt ?? context.systemPrompt,
						)
					: undefined;
			afterMeasurement = await measure(result);
			const protectedPrompt = [...context.messages]
				.reverse()
				.find(isTurnStartMessage);
			const protectsCurrentPrompt = (
				candidate: CoreCompactionResult | undefined,
			) =>
				!protectedPrompt ||
				candidate?.messages.some(
					(message) =>
						message.role === protectedPrompt.role &&
						JSON.stringify(message.content) ===
							JSON.stringify(protectedPrompt.content),
				);
			const validCandidate = () =>
				!!afterMeasurement &&
				!!result?.messages?.length &&
				protectsCurrentPrompt(result) &&
				(executedStrategy !== "basic" ||
					context.messages
						.filter(
							(message) => message.metadata?.kind === "compaction_summary",
						)
						.every((checkpoint) =>
							result?.messages.some(
								(message) =>
									JSON.stringify(message.content) ===
									JSON.stringify(checkpoint.content),
							),
						)) &&
				afterMeasurement.inputTokens <= afterMeasurement.maxInputTokens &&
				afterMeasurement.inputTokens < requestInputTokens;
			const continuityCeiling = Math.min(
				userCompaction.maxTargetTokens ?? Number.POSITIVE_INFINITY,
				requestTriggerTokens -
					Math.max(2 * beforeMeasurement.maxOutputTokens, buffer),
				beforeMeasurement.maxInputTokens -
					Math.max(2 * beforeMeasurement.maxOutputTokens, buffer),
			);
			const acceptable = () =>
				validCandidate() &&
				((afterMeasurement?.inputTokens ?? Number.POSITIVE_INFINITY) <=
					requestTargetTokens ||
					// The preferred shrink target must not replace a useful semantic
					// checkpoint with a lossy fold when there is measured growth room.
					(effectiveMode === "auto" &&
						(executedStrategy === "agentic" ||
							userCompaction.maxTargetTokens !== undefined) &&
						(afterMeasurement?.inputTokens ?? Number.POSITIVE_INFINITY) <=
							continuityCeiling));
			// Reproject from the original transcript so repeated fallback attempts
			// do not stack summaries or lose the protected prompt's identity.
			for (let attempt = 0; attempt < 8 && !acceptable(); attempt++) {
				context.abortSignal.throwIfAborted();
				const current = afterMeasurement?.inputTokens ?? requestInputTokens;
				const adjustedTarget = Math.max(
					1,
					Math.floor(
						messageTargetTokens *
							Math.min(0.8, requestTargetTokens / Math.max(1, current)) **
								(attempt + 1),
					),
				);
				const folded = runBasicCompaction({
					context: {
						...compactionContext,
						budget: {
							...compactionContext.budget,
							messages: {
								...compactionContext.budget.messages,
								targetTokens: adjustedTarget,
							},
						},
					},
					estimateMessageTokens,
					logger: config.logger,
					refoldPreserved: true,
				});
				if (!folded?.messages?.length) continue;
				const counted = await measure(folded);
				if (!counted)
					throw new Error(
						"Input token counter became unavailable; original context was preserved",
					);
				if (
					protectsCurrentPrompt(folded) &&
					(!validCandidate() ||
						counted.inputTokens < (afterMeasurement?.inputTokens ?? Infinity))
				) {
					result = folded;
					afterMeasurement = counted;
					executedStrategy = "basic";
				}
			}
			if (!acceptable()) {
				const reason = !result?.messages?.length
					? "no_usable_result"
					: !protectsCurrentPrompt(result)
						? "protected_prompt_changed"
						: "target_not_reached";
				config.logger?.log("Measured compaction candidate rejected", {
					severity: "warn",
					reason,
					inputTokens: requestInputTokens,
					candidateInputTokens: afterMeasurement?.inputTokens,
					targetTokens: requestTargetTokens,
					maxInputTokens,
				});
				// A single protected request has no history to reduce. Allow it
				// under the hard limit without claiming successful compaction.
				if (
					context.messages.length <= 1 &&
					requestInputTokens <= beforeMeasurement.maxInputTokens &&
					effectiveMode !== "overflow_recovery"
				) {
					if (irreducibleRequests.size >= 32) irreducibleRequests.clear();
					irreducibleRequests.add(
						beforeMeasurement.fingerprint + beforeMeasurement.budgetRevision,
					);
					context.emitStatusNotice?.(`${noticePrefix}compaction-skipped`, {
						kind: statusReason,
						phase: "skipped",
						reason: "no_reducible_context",
						inputTokens: requestInputTokens,
						targetTokens: requestTargetTokens,
						maxInputTokens,
					});
					return undefined;
				}
				throw new Error(
					`Compaction could not reach the measured target (${Math.floor(requestTargetTokens)} tokens; candidate input ${afterMeasurement?.inputTokens ?? requestInputTokens}; hard input allowance ${beforeMeasurement.maxInputTokens}; reason: ${reason}). Original context was preserved.`,
				);
			}
			if (!afterMeasurement)
				throw new Error(
					"Input token counting failed; original context was preserved",
				);
		}

		if (
			!beforeMeasurement &&
			maxResultTokens !== undefined &&
			result?.messages
		) {
			const candidateTokens = estimateRequestInputTokens({
				systemPrompt: result.systemPrompt ?? context.systemPrompt,
				messages: result.messages,
				tools: context.tools,
			});
			if (candidateTokens > maxResultTokens) {
				throw new Error(
					`Compaction exceeds the configured maximum (${maxResultTokens} tokens; candidate estimate ${candidateTokens}). Original context was preserved.`,
				);
			}
		}

		context.abortSignal.throwIfAborted();
		const durationMs = Date.now() - startedAt;
		// Telemetry identity: surface the agent/conversation passed into the
		// prepareTurn so multi-agent runs can attribute compactions correctly.
		// `sessionId` is the host-owned session id (ulid). We fall back to the
		// conversation id when no sessionId is supplied (e.g. ad-hoc callers).
		const telemetryUlid = config.sessionId ?? context.conversationId;
		const telemetryIdentity = {
			agentId: context.agentId,
			conversationId: context.conversationId,
			parentAgentId: context.parentAgentId ?? undefined,
		};

		if (result?.messages) {
			const afterMessageTokens = result.messages.reduce(
				(total: number, message) => total + estimateMessageTokens(message),
				0,
			);
			const afterRequestTokens =
				afterMeasurement?.inputTokens ??
				estimateRequestInputTokens({
					systemPrompt: result.systemPrompt ?? context.systemPrompt,
					messages: result.messages,
					tools: context.tools,
				});
			config.logger?.log("Context compaction completed", {
				severity: "info",
				strategy: executedStrategy,
				maxInputTokens,
				messageInputTokens,
				apiInputTokens: apiMessageTokens,
				requestInputTokens,
				requestOverheadTokens,
				afterMessageTokens,
				afterRequestTokens,
				tokensSaved: requestInputTokens - afterRequestTokens,
				utilizationBefore: `${((requestInputTokens / maxInputTokens) * 100).toFixed(1)}%`,
				utilizationAfter: `${((afterRequestTokens / maxInputTokens) * 100).toFixed(1)}%`,
				thresholdTrigger: `${((requestTriggerTokens / maxInputTokens) * 100).toFixed(1)}%`,
				preferredTargetTokens: requestTargetTokens,
				effectiveTargetTokens: Math.max(
					requestTargetTokens,
					afterRequestTokens,
				),
				maxTargetTokens: userCompaction.maxTargetTokens,
				messagesBefore: beforeMessageCount,
				messagesAfter: result.messages.length,
				messagesRemoved: beforeMessageCount - result.messages.length,
			} as Record<string, unknown>);
			if (afterMeasurement)
				context.emitStatusNotice?.("input-token-count", {
					kind: "input_token_count",
					...afterMeasurement,
				});
			context.emitStatusNotice?.(`${noticePrefix}compacted`, {
				kind: statusReason,
				reason: statusReason,
				phase: "completed",
				preferredTargetTokens: requestTargetTokens,
				effectiveTargetTokens: Math.max(
					requestTargetTokens,
					afterRequestTokens,
				),
				maxTargetTokens: userCompaction.maxTargetTokens,
				iteration: context.iteration,
				tokensBefore: requestInputTokens,
				tokensAfter: afterRequestTokens,
				countSource: beforeMeasurement?.source ?? "estimated",
				requestFingerprintBefore: beforeMeasurement?.fingerprint,
				requestFingerprintAfter: afterMeasurement?.fingerprint,
				budgetRevision: afterMeasurement?.budgetRevision,
				messagesBefore: beforeMessageCount,
				messagesAfter: result.messages.length,
				maxInputTokens,
			});
			captureCompactionExecuted(config.telemetry, {
				ulid: telemetryUlid,
				strategy: executedStrategy,
				mode: effectiveMode,
				messagesBefore: beforeMessageCount,
				messagesAfter: result.messages.length,
				messagesRemoved: beforeMessageCount - result.messages.length,
				tokensBefore: requestInputTokens,
				tokensAfter: afterRequestTokens,
				tokensSaved: requestInputTokens - afterRequestTokens,
				triggerTokens: requestTriggerTokens,
				maxInputTokens,
				thresholdRatio: requestTriggerTokens / maxInputTokens,
				durationMs,
				// Matches the field name used by other TASK telemetry helpers
				// (e.g. captureTaskCompleted, captureToolUsage).
				provider: config.providerId,
				modelId: config.modelId,
				...telemetryIdentity,
			});
			if (
				result.budget &&
				(result.budget.actionCount > 0 || result.budget.warningCount > 0)
			) {
				captureCompactionBudgetEmergency(config.telemetry, {
					ulid: telemetryUlid,
					strategy: executedStrategy,
					mode: effectiveMode,
					policyIntent: result.budget.policyIntent,
					actionCount: result.budget.actionCount,
					warningCount: result.budget.warningCount,
					liveTailHandling: result.budget.liveTailHandling,
					provider: config.providerId,
					modelId: config.modelId,
					...telemetryIdentity,
				});
				context.emitStatusNotice?.("compaction-budget-adjusted", {
					kind: "compaction_budget_emergency",
					reason: "compaction_budget_emergency",
					iteration: context.iteration,
					policyIntent: result.budget.policyIntent,
					actionCount: result.budget.actionCount,
					warningCount: result.budget.warningCount,
				});
			}
		} else {
			context.emitStatusNotice?.(`${noticePrefix}compaction-skipped`, {
				kind: statusReason,
				reason: statusReason,
				phase: "skipped",
				iteration: context.iteration,
				maxInputTokens,
			});
			captureCompactionSkipped(config.telemetry, {
				ulid: telemetryUlid,
				strategy: executedStrategy,
				mode: effectiveMode,
				reason: "no_result",
				tokensBefore: requestInputTokens,
				triggerTokens: requestTriggerTokens,
				maxInputTokens,
				thresholdRatio: requestTriggerTokens / maxInputTokens,
				durationMs,
				provider: config.providerId,
				modelId: config.modelId,
				...telemetryIdentity,
			});
		}

		return result;
	};
}

/**
 * Compaction policy for resuming a session imported from another coding agent.
 * The imported transcript keeps that agent's tool names and input schemas
 * verbatim, which a model continuing it may try to call, so the first turn
 * folds the whole foreign history into a summary before the model request
 * (manual mode, agentic strategy, nothing preserved but the new prompt).
 * Runs regardless of the session's auto-compaction setting, tags its status
 * notices with `importedFrom` so clients can label the wait, and on failure
 * falls back to the raw transcript. It makes one attempt per session start
 * (an aborted attempt does not count) and stands down once the working
 * context already opens with a compaction summary, which is how a resumed
 * sidecar presents; every other turn defers to `next`, the session's normal
 * compaction (if any).
 */
export function createImportedHistoryCompactionPrepareTurn(input: {
	config: Parameters<typeof createContextCompactionPrepareTurn>[0];
	/** Source tool id from the session's `importedFrom` metadata. */
	importedFrom: string;
	next?: ContextPipelinePrepareTurn;
}): ContextPipelinePrepareTurn {
	// Pass the live config through (not a copy) so the summary uses the
	// credentials and model current on the resumed turn.
	const summarize = createContextCompactionPrepareTurn(input.config, {
		mode: "manual",
		compaction: { enabled: true, strategy: "agentic", preserveRecentTokens: 0 },
	});
	let pending = summarize !== undefined;
	return async (context) => {
		if (pending && summarize && findLatestSummaryIndex(context.messages) < 0) {
			try {
				const result = await summarize({
					...context,
					emitStatusNotice: (message, metadata) =>
						context.emitStatusNotice?.(message, {
							...metadata,
							importedFrom: input.importedFrom,
						}),
				});
				pending = false;
				if (result?.messages) return result;
			} catch (error) {
				if (context.abortSignal.aborted) throw error;
				pending = false;
				input.config.logger?.log(
					"Failed to summarize imported session on resume; continuing with the raw transcript",
					{
						severity: "warn",
						sessionId: input.config.sessionId,
						...describeCompactionError(error),
					},
				);
			}
		}
		return input.next?.(context);
	};
}

export function createCompactionStateAwarePrepareTurn(input: {
	compact?: ContextPipelinePrepareTurn;
	getState?: () => SessionCompactionState | undefined;
	/**
	 * The runtime's provider-request transform (extension message builders +
	 * `MessageBuilder.buildForApi`), i.e. what produced `context.apiMessages`
	 * from `context.messages`. Re-compaction swaps in a projected transcript
	 * and must estimate against its API-safe form, not the raw projection.
	 */
	prepareApiMessages: (
		messages: CoreCompactionContext["messages"],
	) => Promise<CoreCompactionContext["messages"]>;
	/**
	 * Persist a freshly-computed compaction state. `sourceMessages` are the
	 * exact canonical messages the state's source-prefix hash was computed
	 * over; hosts must validate projection against these rather than a
	 * separately derived transcript, which can legally differ mid-turn and
	 * spuriously reject the write.
	 */
	saveState?: (
		state: SessionCompactionState,
		sourceMessages: CoreCompactionContext["messages"],
	) => void | Promise<void>;
}): ContextPipelinePrepareTurn {
	return async (context) => {
		const existingState = input.getState?.();
		const projectedMessages = existingState
			? projectSessionCompactionState(existingState, context.messages)
			: undefined;
		if (existingState && projectedMessages) {
			// Re-compaction intentionally starts from the compacted projection plus
			// canonical tail. This keeps automatic turns bounded without rebuilding a
			// full-transcript summary every turn; manual `/compact` is the path for a
			// fresh summary from canonical history.
			const result = input.compact
				? await input.compact({
						...context,
						messages: projectedMessages,
						apiMessages: await input.prepareApiMessages(projectedMessages),
					})
				: undefined;
			if (result?.messages) {
				const systemPrompt = result.systemPrompt ?? existingState.system_prompt;
				const nextState = createSessionCompactionState({
					sourceMessages: context.messages,
					compactedMessages: result.messages,
					conversationId: context.conversationId,
					systemPrompt,
				});
				await input.saveState?.(nextState, context.messages);
				return {
					...result,
					messages: nextState.messages,
					...(systemPrompt !== undefined ? { systemPrompt } : {}),
				};
			}
			return {
				messages: projectedMessages,
				...(result?.systemPrompt !== undefined
					? { systemPrompt: result.systemPrompt }
					: existingState.system_prompt !== undefined
						? { systemPrompt: existingState.system_prompt }
						: {}),
			};
		}
		const result = input.compact ? await input.compact(context) : undefined;
		if (result?.messages) {
			const nextState = createSessionCompactionState({
				sourceMessages: context.messages,
				compactedMessages: result.messages,
				conversationId: context.conversationId,
				systemPrompt: result.systemPrompt,
			});
			await input.saveState?.(nextState, context.messages);
			// Use the same captured memory on the first request and subsequent
			// sidecar projections, so the first tool continuation reuses KV too.
			return { ...result, messages: nextState.messages };
		}
		return result;
	};
}
