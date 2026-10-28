import { createHash } from "node:crypto";
import type { ModelInfo, ProviderConfig } from "@cline/llms";
import {
	type LocalInferenceSettings,
	LocalInferenceSettingsSchema,
	localInferenceEngine,
	localInferenceUrl,
} from "@cline/shared";

const defaults = new Map<string, LocalInferenceSettings>();
export function localModelProfileKey(
	baseUrl: string | undefined,
	model: string,
): string {
	return JSON.stringify([
		createHash("sha256")
			.update(baseUrl?.replace(/\/+$/, "") ?? "")
			.digest("hex"),
		model,
	]);
}
export function getLocalModelDefaults(
	baseUrl: string | undefined,
	model: string,
	provider = "",
): LocalInferenceSettings | undefined {
	const value = defaults.get(provider + localModelProfileKey(baseUrl, model));
	return value
		? {
				...structuredClone(value),
				...(Object.keys(value).length ? { userOverrides: [] } : {}),
			}
		: undefined;
}
const positive = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Only values actually reported by the server are initialization defaults. */
export function parseLocalModelDefaults(
	value: unknown,
): LocalInferenceSettings {
	const raw = record(value),
		meta = record(raw.meta);
	const generation = record(
		raw.default_generation_settings ??
			meta.default_generation_settings ??
			raw.generation_config,
	);
	const params = { ...generation, ...record(generation.params) };
	const controls: Record<string, unknown> = {};
	const caps = record(raw.capabilities);
	for (const [key, value] of Object.entries({
		supportsVision: raw.supports_vision ?? caps.vision,
		supportsTools: raw.supports_tools ?? caps.function_calling,
		supportsReasoning: raw.supports_reasoning ?? caps.reasoning,
	}))
		if (typeof value === "boolean") controls[key] = value;
	const context = positive(
		raw.max_model_len ??
			raw.context_length ??
			raw.context_window ??
			meta.n_ctx ??
			generation.n_ctx,
	);
	if (context) controls.contextWindow = context;
	const mappings = {
		maxOutputTokens: "max_tokens",
		temperature: "temperature",
		topP: "top_p",
		topK: "top_k",
		minP: "min_p",
		repeatPenalty: "repeat_penalty",
		presencePenalty: "presence_penalty",
		frequencyPenalty: "frequency_penalty",
		thinkingBudgetTokens: "thinking_token_budget",
	};
	for (const [key, wire] of Object.entries(mappings))
		if (typeof params[wire] === "number") controls[key] = params[wire];
	const output = positive(
		raw.max_output_tokens ??
			raw.max_tokens ??
			params.max_tokens ??
			params.n_predict,
	);
	if (output) controls.maxOutputTokens = output;
	else delete controls.maxOutputTokens;
	if (typeof params.repetition_penalty === "number")
		controls.repeatPenalty = params.repetition_penalty;
	if (typeof params.reasoning_budget_tokens === "number")
		controls.thinkingBudgetTokens = params.reasoning_budget_tokens;
	if (typeof params.reasoning_effort === "string")
		controls.reasoningEffort = params.reasoning_effort;
	const kwargs = record(
		raw.chat_template_kwargs ?? params.chat_template_kwargs,
	);
	if (typeof kwargs.enable_thinking === "boolean")
		controls.thinking = kwargs.enable_thinking;
	if (typeof kwargs.reasoning_effort === "string")
		controls.reasoningEffort = kwargs.reasoning_effort;
	if (typeof raw.input_token_counting === "boolean")
		controls.inputTokenCounting = raw.input_token_counting;
	// Parse fields independently: e.g. an unlimited n_predict=-1 must not discard
	// a perfectly usable context length or temperature reported alongside it.
	return Object.fromEntries(
		Object.entries(controls).filter(
			([key, value]) =>
				LocalInferenceSettingsSchema.safeParse({ [key]: value }).success,
		),
	) as LocalInferenceSettings;
}

export async function discoverLocalInferenceModels(
	config: ProviderConfig,
): Promise<Record<string, ModelInfo>> {
	if (!localInferenceEngine(config.providerId) || !config.baseUrl) return {};
	const fetcher = config.fetch ?? globalThis.fetch;
	const headers = {
		...config.headers,
		...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
	};
	const response = await fetcher(
		localInferenceUrl(config.baseUrl, "/v1/models"),
		{ headers, signal: AbortSignal.timeout(15000) },
	);
	if (!response.ok)
		throw new Error(`Model discovery failed (HTTP ${response.status})`);
	const raw = await response.text();
	if (raw.length > 8 * 1024 * 1024)
		throw new Error("Model catalog is too large");
	const data = JSON.parse(raw) as { data?: unknown[] };
	if (!Array.isArray(data.data))
		throw new Error("Invalid native model catalog");
	const result: Record<string, ModelInfo> = Object.create(null);
	for (const value of data.data) {
		const entry = record(value);
		if (typeof entry.id !== "string" || !entry.id) continue;
		const settings = parseLocalModelDefaults(entry);
		defaults.set(
			config.providerId + localModelProfileKey(config.baseUrl, entry.id),
			settings,
		);
		const caps = record(entry.capabilities);
		const capabilities: NonNullable<ModelInfo["capabilities"]> = ["streaming"];
		if (caps.function_calling === true || entry.supports_tools === true)
			capabilities.push("tools");
		if (caps.vision === true || entry.supports_vision === true)
			capabilities.push("images");
		if (caps.reasoning === true || entry.supports_reasoning === true)
			capabilities.push("reasoning");
		result[entry.id] = {
			id: entry.id,
			name: typeof entry.name === "string" ? entry.name : entry.id,
			contextWindow: settings.contextWindow,
			maxTokens: settings.maxOutputTokens,
			capabilities,
			metadata: { localInference: settings },
		};
	}
	// Bound process-local discovery state; saved profiles are persisted separately.
	while (defaults.size > 256) defaults.delete(defaults.keys().next().value!);
	return result;
}

/** Enrich only a selected, already-running llama.cpp model. Never autoload it. */
export async function refreshLocalModelDefaults(
	config: ProviderConfig,
	model: string,
): Promise<void> {
	if (config.providerId !== "llamacpp" || !config.baseUrl) return;
	const url = new URL(localInferenceUrl(config.baseUrl, "/props"));
	url.searchParams.set("model", model);
	url.searchParams.set("autoload", "false");
	const response = await (config.fetch ?? globalThis.fetch)(url, {
		headers: {
			...config.headers,
			...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
		},
		signal: AbortSignal.timeout(5000),
	});
	// Missing introspection is not a failed declared counter. Leave unknowns unset.
	if (
		response.status === 404 ||
		response.status === 409 ||
		response.status === 501 ||
		response.status === 503
	)
		return;
	if (!response.ok)
		throw new Error(
			`Selected model settings discovery failed (HTTP ${response.status})`,
		);
	const raw = await response.text();
	if (raw.length > 1024 * 1024)
		throw new Error("Model properties are too large");
	const settings = parseLocalModelDefaults(JSON.parse(raw));
	defaults.set(
		config.providerId + localModelProfileKey(config.baseUrl, model),
		{
			...getLocalModelDefaults(config.baseUrl, model, config.providerId),
			...settings,
		},
	);
}

/** Project one saved native profile into runtime model metadata. */
export function localInferenceModelInfo(
	model: string,
	settings: LocalInferenceSettings,
	previous?: ModelInfo,
): ModelInfo {
	const capabilities = new Set<NonNullable<ModelInfo["capabilities"]>[number]>(
		previous?.capabilities ?? ["streaming"],
	);
	for (const [flag, capability] of [
		["supportsVision", "images"],
		["supportsTools", "tools"],
		["supportsReasoning", "reasoning"],
	] as const) {
		if (settings[flag] === true) capabilities.add(capability);
		if (settings[flag] === false) capabilities.delete(capability);
	}
	return {
		...previous,
		id: model,
		contextWindow: settings.contextWindow,
		maxInputTokens: settings.maxInputTokens,
		maxTokens: settings.maxOutputTokens,
		capabilities: [...capabilities],
		metadata: { ...previous?.metadata, localInference: settings },
	};
}
