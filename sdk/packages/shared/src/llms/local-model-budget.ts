import {
	DEFAULT_LOCAL_OUTPUT_TOKENS,
	type LocalInferenceSettings,
	resolveLocalInferenceSettings,
} from "./local-inference";

export const DEFAULT_COMPACTION_BUFFER_TOKENS = 128;
export { DEFAULT_LOCAL_OUTPUT_TOKENS } from "./local-inference";
export const ESTIMATED_INSTRUCTION_TOKENS = 10_000;
export const COMPACTION_TRIGGER_RATIO = 0.9;

// Decimal token counts, with continuous linear interpolation between examples.
const anchors = [
	[40_000, 4_000, 10_000],
	[64_000, 8_000, 14_000],
	[100_000, 10_000, 25_000],
	[150_000, 14_000, 40_000],
	[200_000, 16_000, 60_000],
] as const;

export function resolveCompactionDefaults(contextWindow: number) {
	let summaryTokens = 16_000,
		recentTokens = 60_000;
	if (contextWindow < anchors[0][0]) {
		const ratio = contextWindow / anchors[0][0];
		summaryTokens = Math.max(1, Math.floor(4_000 * ratio));
		recentTokens = Math.max(0, Math.floor(10_000 * ratio));
	} else {
		for (let i = 1; i < anchors.length; i++) {
			const lo = anchors[i - 1],
				hi = anchors[i];
			if (contextWindow <= hi[0]) {
				const ratio = (contextWindow - lo[0]) / (hi[0] - lo[0]);
				summaryTokens = Math.floor(lo[1] + (hi[1] - lo[1]) * ratio);
				recentTokens = Math.floor(lo[2] + (hi[2] - lo[2]) * ratio);
				break;
			}
		}
	}
	return {
		summaryTokens,
		recentTokens,
		targetTokens: ESTIMATED_INSTRUCTION_TOKENS + summaryTokens + recentTokens,
	};
}

/** Thinking is included in normal output, so reserve it only once. */
export function resolveLocalInferenceInputTokens(input: {
	contextWindow?: number;
	maxOutputTokens?: number;
	maxInputTokens?: number;
	nativeCounting: boolean;
}): number | undefined {
	if (!input.contextWindow || !input.maxOutputTokens) return undefined;
	const available =
		input.contextWindow -
		input.maxOutputTokens -
		(input.nativeCounting ? 1 : 0);
	if (available < 1)
		throw new Error("Output allowance leaves no usable input capacity");
	return Math.min(input.maxInputTokens ?? Infinity, available);
}

export function resolveLocalModelBudget(
	raw: LocalInferenceSettings,
	options: {
		contextWindow?: number;
		maxOutputTokens?: number;
		overheadTokens?: number;
	} = {},
) {
	const settings = resolveLocalInferenceSettings(raw);
	const configuredContext = settings.contextWindow;
	if (!configuredContext)
		throw new Error(
			"Maximum context size is required: discover it from the server or enter it manually.",
		);
	if (!Number.isSafeInteger(configuredContext) || configuredContext <= 0)
		throw new Error("Maximum context size must be a positive whole number.");
	const contextWindow = Math.min(
		configuredContext,
		options.contextWindow ?? Infinity,
	);
	const maxOutputTokens =
		options.maxOutputTokens ??
		settings.maxOutputTokens ??
		DEFAULT_LOCAL_OUTPUT_TOKENS;
	if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
		throw new Error("Normal output must be a positive whole number.");
	const nativeCounting = settings.inputTokenCounting !== false;
	const boundaryTokens = nativeCounting ? 1 : 0;
	const inputTokens = resolveLocalInferenceInputTokens({
		contextWindow,
		maxOutputTokens,
		nativeCounting,
	})!;
	const marginTokens =
		settings.compaction?.bufferTokens ?? DEFAULT_COMPACTION_BUFFER_TOKENS;
	if (!Number.isSafeInteger(marginTokens) || marginTokens < 0)
		throw new Error("Counting margin must be a nonnegative whole number.");
	const hardCapTokens = inputTokens - marginTokens;
	if (hardCapTokens < 1)
		throw new Error(
			"Normal output and counting margin leave no input capacity.",
		);
	const defaults = resolveCompactionDefaults(contextWindow);
	const targetTokens =
		settings.compaction?.targetTokens ??
		Math.min(defaults.targetTokens, hardCapTokens);
	if (!Number.isSafeInteger(targetTokens) || targetTokens <= 0)
		throw new Error("Compaction target must be a positive whole number.");
	if (targetTokens > hardCapTokens)
		throw new Error(
			`Compaction target exceeds the calculated hard cap (${hardCapTokens} tokens).`,
		);
	const summaryTokens =
		settings.compaction?.summaryTokens ??
		Math.min(defaults.summaryTokens, Math.max(1, targetTokens - 1));
	if (!Number.isSafeInteger(summaryTokens) || summaryTokens <= 0)
		throw new Error(
			"Summarized history budget must be a positive whole number.",
		);
	if (summaryTokens >= targetTokens)
		throw new Error(
			"Summarized history budget must be smaller than the compaction target.",
		);
	const overheadTokens = options.overheadTokens ?? ESTIMATED_INSTRUCTION_TOKENS;
	return {
		contextWindow,
		maxOutputTokens,
		boundaryTokens,
		marginTokens,
		inputTokens,
		hardCapTokens,
		targetTokens,
		summaryTokens,
		overheadTokens,
		recentTokens: Math.max(0, targetTokens - summaryTokens - overheadTokens),
		growthTokens: Math.max(0, hardCapTokens - targetTokens),
	};
}
export type LocalModelBudget = ReturnType<typeof resolveLocalModelBudget>;

/** No conversation-pair threshold: defaults depend continuously on capacity. */
export function resolveAutoCompactionTargetTokens(input: {
	maxInputTokens: number;
	modelMaxTokens?: number;
	contextWindow?: number;
	triggerTokens: number;
}): number {
	const contextWindow =
		input.contextWindow ??
		input.maxInputTokens +
			(input.modelMaxTokens ?? DEFAULT_LOCAL_OUTPUT_TOKENS);
	return Math.max(
		1,
		Math.min(
			resolveCompactionDefaults(contextWindow).targetTokens,
			input.maxInputTokens,
			Math.max(1, input.triggerTokens - 1),
		),
	);
}
