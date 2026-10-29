import { z } from "zod";

export const DEFAULT_LOCAL_OUTPUT_TOKENS = 8_000;
export const LocalModelProfileIdSchema = z.enum(["default", "p1", "p2"]);
export type LocalModelProfileId = z.infer<typeof LocalModelProfileIdSchema>;

export const LOCAL_INFERENCE_OVERRIDE_FIELDS = [
	"supportsVision",
	"supportsTools",
	"supportsReasoning",
	"contextWindow",
	"maxInputTokens",
	"maxOutputTokens",
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"frequencyPenalty",
	"repeatPenalty",
	"thinking",
	"reasoningEffort",
	"thinkingBudgetTokens",
	"compaction.bufferTokens",
	"compaction.targetTokens",
	"compaction.summaryTokens",
	"compaction.maxTargetTokens",
	"compaction.preserveRecentTokens",
] as const;
export type LocalInferenceOverrideField =
	(typeof LOCAL_INFERENCE_OVERRIDE_FIELDS)[number];

/** Model controls only. Connection credentials belong to the provider. */
export const LocalInferenceSettingsSchema = z
	.object({
		/** Explicit user edits; absent only on profiles saved before provenance tracking. */
		userOverrides: z
			.array(z.enum(LOCAL_INFERENCE_OVERRIDE_FIELDS))
			.max(32)
			.optional(),
		/** Inactive overrides keep their saved values for later re-enabling. */
		disabledOverrides: z
			.array(z.enum(LOCAL_INFERENCE_OVERRIDE_FIELDS))
			.max(32)
			.optional(),
		serverDefaults: z
			.object({
				contextWindow: z.number().int().positive().optional(),
				maxOutputTokens: z.number().int().positive().optional(),
			})
			.optional(),
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
				summaryTokens: z.number().int().positive().optional(),
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

/** Legacy equal-to-default values cannot prove an edit; preserve every differing or unknown value as an override. */
export function localInferenceUserOverrides(
	settings: LocalInferenceSettings,
	defaults: LocalInferenceSettings = {},
): LocalInferenceOverrideField[] {
	if (settings.userOverrides) return settings.userOverrides;
	const value = (
		source: LocalInferenceSettings,
		key: LocalInferenceOverrideField,
	) =>
		key.startsWith("compaction.")
			? source.compaction?.[
					key.slice(11) as keyof NonNullable<
						LocalInferenceSettings["compaction"]
					>
				]
			: source[key as keyof LocalInferenceSettings];
	return LOCAL_INFERENCE_OVERRIDE_FIELDS.filter(
		(key) =>
			value(settings, key) !== undefined &&
			!Object.is(value(settings, key), value(defaults, key)),
	);
}

/** Project active values without deleting the user's inactive overrides. */
export function resolveLocalInferenceSettings(
	settings: LocalInferenceSettings,
): LocalInferenceSettings {
	const out: LocalInferenceSettings = {
		...settings,
		compaction: settings.compaction ? { ...settings.compaction } : undefined,
	};
	for (const field of settings.disabledOverrides ?? []) {
		if (field.startsWith("compaction.")) {
			if (out.compaction)
				delete out.compaction[
					field.slice(11) as keyof NonNullable<
						LocalInferenceSettings["compaction"]
					>
				];
		} else if (field === "contextWindow" || field === "maxOutputTokens") {
			out[field] = settings.serverDefaults?.[field];
		}
	}
	out.contextWindow ??= settings.serverDefaults?.contextWindow;
	out.maxOutputTokens ??=
		settings.serverDefaults?.maxOutputTokens ?? DEFAULT_LOCAL_OUTPUT_TOKENS;
	return out;
}
