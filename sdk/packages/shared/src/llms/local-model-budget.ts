/** Shared by context compaction and its settings preview. */
export const DEFAULT_COMPACTION_BUFFER_TOKENS = 2_048;
export const COMPACTION_TRIGGER_RATIO = 0.9;
export const DEFAULT_TARGET_RATIO = 0.7;

/** Thinking is already included in maxOutputTokens; reserve it only once. */
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

export function resolveAutoCompactionTargetTokens(input: {
	maxInputTokens: number;
	modelMaxTokens?: number;
	triggerTokens: number;
	messagePairCount: number;
}): number {
	const targetTokens =
		input.messagePairCount >= 5 &&
		typeof input.modelMaxTokens === "number" &&
		Number.isFinite(input.modelMaxTokens) &&
		input.modelMaxTokens < input.maxInputTokens
			? Math.floor(input.maxInputTokens * 0.5)
			: Math.floor(input.triggerTokens * DEFAULT_TARGET_RATIO);
	return Math.max(
		1,
		Math.min(
			targetTokens,
			input.maxInputTokens,
			Math.max(1, input.triggerTokens - 1),
		),
	);
}
