import { z } from "zod";

/** Model controls only. Connection credentials belong to the provider. */
export const LocalInferenceSettingsSchema = z
	.object({
		supportsVision: z.boolean().optional(),
		supportsTools: z.boolean().optional(),
		supportsReasoning: z.boolean().optional(),
		contextWindow: z.number().int().positive().optional(),
		maxInputTokens: z.number().int().positive().optional(),
		maxOutputTokens: z.number().int().positive().optional(),
		temperature: z.number().min(0).max(2).optional(),
		topP: z.number().min(0).max(1).optional(),
		topK: z.number().int().nonnegative().optional(),
		minP: z.number().min(0).max(1).optional(),
		presencePenalty: z.number().min(-2).max(2).optional(),
		frequencyPenalty: z.number().min(-2).max(2).optional(),
		repeatPenalty: z.number().positive().optional(),
		thinking: z.boolean().optional(),
		reasoningEffort: z.string().min(1).max(64).optional(),
		thinkingBudgetTokens: z.number().int().nonnegative().optional(),
		/** Capability declaration, not a health probe or an outage fallback switch. */
		inputTokenCounting: z.boolean().optional(),
		compaction: z
			.object({
				bufferTokens: z.number().int().nonnegative().optional(),
				targetTokens: z.number().int().positive().optional(),
				maxTargetTokens: z.number().int().positive().optional(),
				preserveRecentTokens: z.number().int().nonnegative().optional(),
			})
			.optional(),
	})
	.strict();
export type LocalInferenceSettings = z.infer<
	typeof LocalInferenceSettingsSchema
>;
export type LocalInferenceEngine = "vllm" | "llama.cpp";
export function localInferenceEngine(
	provider: string,
): LocalInferenceEngine | undefined {
	return provider === "vllm"
		? "vllm"
		: provider === "llamacpp"
			? "llama.cpp"
			: undefined;
}

/** Retain reverse proxy mount paths when finding versionless native endpoints. */
export function localInferenceUrl(baseUrl: string, route: string): string {
	const base = new URL(baseUrl);
	base.pathname =
		base.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + route;
	base.search = "";
	base.hash = "";
	return base.toString();
}
