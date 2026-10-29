import { createHash } from "node:crypto";
import {
	DEFAULT_COMPACTION_BUFFER_TOKENS,
	type LocalInferenceEngine,
	type LocalInferenceSettings,
	localInferenceUrl,
	type RequestInputTokenCount,
	resolveLocalInferenceInputTokens,
	resolveLocalInferenceSettings,
	resolveLocalModelBudget,
} from "@cline/shared";

export interface NativeCountOptions {
	engine: LocalInferenceEngine;
	baseUrl: string;
	settings: LocalInferenceSettings;
	timeoutMs?: number;
}

/** A single codec is used by the real transport and its count-only transport. */
export function normalizeLocalInferenceRequest(
	body: Record<string, unknown>,
	engine: LocalInferenceEngine,
	settings: LocalInferenceSettings,
): Record<string, unknown> {
	settings = resolveLocalInferenceSettings(settings);
	resolveLocalModelBudget(settings);
	const out = { ...body };
	const kwargs = {
		...((body.chat_template_kwargs as Record<string, unknown>) ?? {}),
	};
	for (const [key, wire] of Object.entries({
		temperature: "temperature",
		topP: "top_p",
		topK: "top_k",
		minP: "min_p",
		presencePenalty: "presence_penalty",
		frequencyPenalty: "frequency_penalty",
		repeatPenalty: engine === "vllm" ? "repetition_penalty" : "repeat_penalty",
	})) {
		const value = settings[key as keyof LocalInferenceSettings];
		if (value !== undefined && out[wire] === undefined) out[wire] = value;
	}
	const supplied =
		out.max_completion_tokens ?? out.max_tokens ?? settings.maxOutputTokens;
	if (typeof supplied === "number")
		out.max_tokens = Math.min(supplied, settings.maxOutputTokens ?? supplied);
	delete out.max_completion_tokens;
	const effort = settings.reasoningEffort ?? out.reasoning_effort;
	const enabled =
		settings.thinking ??
		(effort === "none" || settings.thinkingBudgetTokens === 0
			? false
			: undefined);
	if (enabled !== undefined) kwargs.enable_thinking = enabled;
	if (effort !== undefined) {
		out.reasoning_effort = enabled === false ? "none" : effort;
		// vLLM merges this field during chat inference; tokenize has no top-level effort.
		kwargs.reasoning_effort = out.reasoning_effort;
	}
	if (enabled === false) {
		out.reasoning_effort = "none";
		kwargs.reasoning_effort = "none";
	}
	if (settings.thinkingBudgetTokens !== undefined || enabled === false) {
		const budget = enabled === false ? 0 : settings.thinkingBudgetTokens!;
		if (
			typeof out.max_tokens === "number" &&
			budget >= out.max_tokens &&
			budget > 0
		)
			throw new Error(
				"Thinking budget must leave room within the total output allowance",
			);
		out[
			engine === "vllm" ? "thinking_token_budget" : "reasoning_budget_tokens"
		] = budget;
	}
	if (Object.keys(kwargs).length) out.chat_template_kwargs = kwargs;
	if (engine === "vllm" && Array.isArray(out.tools) && out.tools.length === 0) {
		if (out.tool_choice && out.tool_choice !== "none")
			throw new Error("Tool choice requires nonempty tools");
		delete out.tools;
	}
	if (
		["truncate_prompt_tokens", "kv_transfer_params", "ec_transfer_params"].some(
			(key) => out[key] != null,
		)
	)
		throw new Error(
			"Prompt truncation and transferred prompt inputs are unsupported by native preflight counting",
		);
	return out;
}

export function nativeCountingEnabled(options: NativeCountOptions): boolean {
	// Native providers declare their count API; an explicit server capability can
	// describe a deployment without it. A failed declared API never changes this.
	return options.settings.inputTokenCounting !== false;
}

/** Native controls still apply when a deployment declares no counting API. */
export function createLocalInferenceFetch(
	delegate: typeof fetch,
	options: NativeCountOptions,
): typeof fetch {
	return (async (input, init) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(String(input), init);
		if (!new URL(request.url).pathname.endsWith("/chat/completions"))
			return delegate(input, init);
		const body = normalizeLocalInferenceRequest(
			(await request.json()) as Record<string, unknown>,
			options.engine,
			options.settings,
		);
		return delegate(new Request(request, { body: JSON.stringify(body) }));
	}) as typeof fetch;
}

function integer(value: unknown, name: string, minimum = 1): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum)
		throw new Error(`Native counter returned invalid ${name}`);
	return value as number;
}

export async function countLocalInferenceRequest(
	fetcher: typeof fetch,
	body: Record<string, unknown>,
	headers: Headers,
	signal: AbortSignal,
	options: NativeCountOptions,
): Promise<RequestInputTokenCount> {
	signal = AbortSignal.any([
		signal,
		AbortSignal.timeout(options.timeoutMs ?? 900000),
	]);
	signal.throwIfAborted();
	const { engine } = options;
	const settings = resolveLocalInferenceSettings(options.settings);
	resolveLocalModelBudget(settings);
	const countBody =
		engine === "vllm"
			? Object.fromEntries(
					Object.entries(body).filter(([key]) =>
						[
							"model",
							"messages",
							"tools",
							"add_generation_prompt",
							"continue_final_message",
							"add_special_tokens",
							"chat_template",
							"chat_template_kwargs",
							"media_io_kwargs",
							"mm_processor_kwargs",
						].includes(key),
					),
				)
			: body;
	if (engine === "vllm")
		countBody.messages = (body.messages as Record<string, unknown>[]).map(
			(message) => {
				const { reasoning_content, ...rest } = message;
				return reasoning_content !== undefined && rest.reasoning === undefined
					? { ...rest, reasoning: reasoning_content }
					: message;
			},
		);
	const route =
		engine === "vllm" ? "/tokenize" : "/v1/chat/completions/input_tokens";
	const response = await fetcher(localInferenceUrl(options.baseUrl, route), {
		method: "POST",
		headers,
		body: JSON.stringify(countBody),
		signal,
	});
	if (!response.ok)
		throw new Error(
			`Declared ${engine} input counter failed (HTTP ${response.status}); request was not sent`,
		);
	const text = await response.text();
	signal.throwIfAborted();
	if (text.length > 16 * 1024 * 1024)
		throw new Error("Native counter response is too large");
	const raw = JSON.parse(text) as Record<string, unknown>;
	const inputTokens = integer(
		raw[engine === "vllm" ? "count" : "input_tokens"],
		"input tokens",
		0,
	);
	if (
		engine === "vllm" &&
		(!Array.isArray(raw.tokens) ||
			raw.tokens.length !== inputTokens ||
			raw.tokens.some((t) => !Number.isSafeInteger(t) || t < 0))
	)
		throw new Error("Native counter returned invalid token IDs");
	let liveContext =
		raw.max_model_len ?? raw.context_window ?? raw.contextWindow;
	if (engine === "llama.cpp" && liveContext === undefined) {
		const catalog = await fetcher(
			localInferenceUrl(options.baseUrl, "/v1/models"),
			{ headers, signal },
		);
		if (!catalog.ok)
			throw new Error("Cannot verify native model context capacity");
		const catalogText = await catalog.text();
		signal.throwIfAborted();
		if (catalogText.length > 8 * 1024 * 1024)
			throw new Error("Model catalog is too large");
		const listing = JSON.parse(catalogText) as {
			data?: Record<string, unknown>[];
		};
		const model = listing.data?.find((m) => m.id === body.model);
		const meta = model?.meta as Record<string, unknown> | undefined;
		const args = (model?.status as { args?: string[] })?.args ?? [];
		const arg = (key: string) =>
			args.includes(key) ? Number(args[args.indexOf(key) + 1]) : undefined;
		// Catalog context may be a per-model total; reject ambiguous parallel slots.
		if (arg("--parallel") !== undefined && arg("--parallel") !== 1)
			throw new Error("Cannot verify single-slot native context capacity");
		liveContext = meta?.n_ctx ?? model?.context_window ?? arg("--ctx-size");
		const slot = arg("--kv-unified-per-slot");
		if (slot && typeof liveContext === "number")
			liveContext = Math.min(slot, liveContext);
	}
	const contextWindow = Math.min(
		integer(liveContext, "context capacity"),
		settings.contextWindow ?? Infinity,
	);
	const maxOutputTokens = integer(body.max_tokens, "output allowance");
	const serverBoundaryTokens = 1;
	const maxInputTokens = integer(
		resolveLocalInferenceInputTokens({
			contextWindow,
			maxOutputTokens,
			nativeCounting: true,
		}),
		"input allowance",
	);
	const digest = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	return {
		inputTokens,
		source: "tokenized",
		fingerprint: digest(countBody),
		budgetRevision: digest({
			engine,
			model: body.model,
			contextWindow,
			maxOutputTokens,
			revision: raw.budget_revision ?? raw.model_revision,
			settings,
		}),
		contextWindow,
		maxInputTokens,
		maxOutputTokens,
		compactionBufferTokens:
			settings.compaction?.bufferTokens ?? DEFAULT_COMPACTION_BUFFER_TOKENS,
		serverBoundaryTokens,
	};
}
