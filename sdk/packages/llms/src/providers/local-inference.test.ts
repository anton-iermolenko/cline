import { describe, expect, it, vi } from "vitest";
import { createGatewayApiHandler } from "./compat";
import { createGateway } from "./gateway";
import { createInputTokenCountFetch } from "./input-token-count";
import {
	countLocalInferenceRequest,
	normalizeLocalInferenceRequest,
} from "./local-inference";

const settings = {
	compaction: { bufferTokens: 0 },
	contextWindow: 100,
	maxOutputTokens: 20,
	thinkingBudgetTokens: 5,
	thinking: true,
	topK: 20,
};
const body = {
	model: "fixture",
	messages: [
		{
			role: "user",
			content: [
				{
					type: "image_url",
					image_url: { url: "data:image/png;base64,Zml4dHVyZQ==" },
				},
				{ type: "text", text: "hi" },
			],
		},
	],
	tools: [
		{
			type: "function",
			function: { name: "fixture", parameters: { type: "object" } },
		},
	],
	max_tokens: 20,
};
const signal = () => new AbortController().signal;
const options = {
	engine: "vllm" as const,
	baseUrl: "http://server/mount/v1",
	settings,
};
const response = (value: unknown) =>
	new Response(JSON.stringify(value), {
		headers: { "Content-Type": "application/json" },
	});
const nativeCount = (count = 40) => ({
	count,
	tokens: Array(count).fill(1),
	max_model_len: 100,
});

describe("native local inference", () => {
	it("normalizes native fields without changing messages, tools or image bytes", () => {
		const result = normalizeLocalInferenceRequest(
			{ ...body, reasoning_effort: "xhigh" },
			"vllm",
			settings,
		);
		expect(result.messages).toEqual(body.messages);
		expect(result.tools).toEqual(body.tools);
		expect(result).toMatchObject({
			top_k: 20,
			thinking_token_budget: 5,
			chat_template_kwargs: {
				enable_thinking: true,
				reasoning_effort: "xhigh",
			},
		});
		const llama = normalizeLocalInferenceRequest(body, "llama.cpp", {
			...settings,
			repeatPenalty: 1.1,
		});
		expect(llama).toMatchObject({
			reasoning_budget_tokens: 5,
			repeat_penalty: 1.1,
		});
		expect(llama).not.toHaveProperty("thinking_token_budget");
	});
	it.each([
		"vllm",
		"llama.cpp",
	] as const)("omits unsupported reasoning controls on %s without changing stored settings", (engine) => {
		const stored = {
			...settings,
			supportsReasoning: false,
			reasoningEffort: "high",
			thinkingBudgetTokens: 25,
		};
		const original = JSON.stringify(stored);
		const serialized = {
			...body,
			reasoning_effort: "high",
			thinking_token_budget: 25,
			reasoning_budget_tokens: 25,
			chat_template_kwargs: {
				enable_thinking: true,
				reasoning_effort: "high",
				custom_option: "keep",
			},
		};
		const normalized = normalizeLocalInferenceRequest(
			serialized,
			engine,
			stored,
		);
		expect(normalized).not.toHaveProperty("reasoning_effort");
		expect(normalized).not.toHaveProperty("thinking_token_budget");
		expect(normalized).not.toHaveProperty("reasoning_budget_tokens");
		expect(normalized.chat_template_kwargs).toEqual({ custom_option: "keep" });
		expect(JSON.stringify(stored)).toBe(original);
		expect(serialized.chat_template_kwargs.enable_thinking).toBe(true);
		expect(normalized.messages).toBe(body.messages);
		expect(normalized.tools).toBe(body.tools);
	});
	it("uses native multimodal tokenization and preserves proxy mount paths and auth", async () => {
		const fetcher = vi.fn(async (url, init) => {
			expect(String(url)).toBe("http://server/mount/tokenize");
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer fixture",
			);
			const request = JSON.parse(String(init?.body));
			expect(request.messages).toEqual(body.messages);
			expect(request.tools).toEqual(body.tools);
			expect(request).not.toHaveProperty("max_tokens");
			return response(nativeCount());
		}) as unknown as typeof fetch;
		const count = await countLocalInferenceRequest(
			fetcher,
			normalizeLocalInferenceRequest(body, "vllm", settings),
			new Headers({ Authorization: "Bearer fixture" }),
			signal(),
			options,
		);
		expect(count).toMatchObject({
			inputTokens: 40,
			contextWindow: 100,
			maxInputTokens: 79,
			maxOutputTokens: 20,
			source: "tokenized",
		});
	});
	it("count-only mode never submits inference and inference counts the same normalized request", async () => {
		const sent: { url: string; body: Record<string, unknown> }[] = [];
		const delegate = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				const data = (await request.json()) as Record<string, unknown>;
				sent.push({ url: request.url, body: data });
				return request.url.endsWith("/tokenize")
					? response(nativeCount())
					: response({ ok: true });
			},
		) as unknown as typeof fetch;
		const measurements: unknown[] = [];
		const counted = createInputTokenCountFetch(
			delegate,
			options.baseUrl,
			true,
			(count) => measurements.push(count),
			options,
		);
		await counted("http://server/mount/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		expect(sent.map((s) => s.url)).toEqual(["http://server/mount/tokenize"]);
		sent.length = 0;
		const infer = createInputTokenCountFetch(
			delegate,
			options.baseUrl,
			false,
			(count) => measurements.push(count),
			options,
		);
		await infer("http://server/mount/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		expect(sent.map((s) => s.url)).toEqual([
			"http://server/mount/tokenize",
			"http://server/mount/v1/chat/completions",
		]);
		for (const key of ["messages", "tools", "chat_template_kwargs"])
			expect(sent[0].body[key]).toEqual(sent[1].body[key]);
		expect(measurements).toHaveLength(2);
	});
	it.each([
		503, 404, 401,
	])("does not hide a declared counter HTTP %s failure or submit inference", async (status) => {
		const delegate = vi.fn(
			async () => new Response("failure", { status }),
		) as unknown as typeof fetch;
		const infer = createInputTokenCountFetch(
			delegate,
			options.baseUrl,
			false,
			() => {},
			options,
		);
		await expect(
			infer("http://server/mount/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		).rejects.toThrow(`HTTP ${status}`);
		expect(delegate).toHaveBeenCalledTimes(1);
	});
	it("rejects malformed counts and overflowing requests without generation", async () => {
		const malformed = vi.fn(async () =>
			response({ count: 2, tokens: [1], max_model_len: 100 }),
		) as unknown as typeof fetch;
		await expect(
			countLocalInferenceRequest(
				malformed,
				body,
				new Headers(),
				signal(),
				options,
			),
		).rejects.toThrow("token IDs");
		const delegate = vi.fn(async () =>
			response(nativeCount(80)),
		) as unknown as typeof fetch;
		await expect(
			createInputTokenCountFetch(
				delegate,
				options.baseUrl,
				false,
				() => {},
				options,
			)("http://server/mount/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		).rejects.toThrow("Context window exceeded");
		expect(delegate).toHaveBeenCalledTimes(1);
	});
	it("validates llama.cpp live slot capacity and reserves output once", async () => {
		const delegate = vi.fn(async (url) =>
			String(url).endsWith("input_tokens")
				? response({ input_tokens: 20 })
				: response({
						data: [
							{
								id: "fixture",
								meta: { n_ctx: 90 },
								status: { args: ["--parallel", "1", "--ctx-size", "90"] },
							},
						],
					}),
		) as unknown as typeof fetch;
		const result = await countLocalInferenceRequest(
			delegate,
			body,
			new Headers(),
			signal(),
			{ ...options, engine: "llama.cpp" },
		);
		expect(result).toMatchObject({
			contextWindow: 90,
			maxInputTokens: 69,
			maxOutputTokens: 20,
		});
	});
	it("requires a known context capacity and rejects unverified truncation", () => {
		expect(() => normalizeLocalInferenceRequest(body, "vllm", {})).toThrow(
			"Maximum context size is required",
		);
		expect(() =>
			normalizeLocalInferenceRequest(
				{ ...body, truncate_prompt_tokens: 1 },
				"vllm",
				settings,
			),
		).toThrow("truncation");
	});
	it("provides a native vLLM counting capability through the real gateway serializer", async () => {
		const calls: Record<string, unknown>[] = [];
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				expect(request.url).toBe("http://server/tokenize");
				calls.push((await request.json()) as Record<string, unknown>);
				return response({
					count: 5,
					tokens: [1, 2, 3, 4, 5],
					max_model_len: 100,
				});
			},
		) as unknown as typeof fetch;
		const gateway = createGateway({
			fetch: fetcher,
			providerConfigs: [
				{
					providerId: "vllm",
					baseUrl: "http://server/v1",
					options: { localInference: settings },
					models: [{ id: "fixture", contextWindow: 100, maxOutputTokens: 20 }],
				},
			],
		});
		const model = gateway.createAgentModel({
			providerId: "vllm",
			modelId: "fixture",
		});
		const count = await model.countInputTokens!({
			messages: [
				{
					id: "message",
					role: "user",
					content: [{ type: "text", text: "hello" }],
					createdAt: 0,
				},
			],
			tools: [],
		});
		expect(count?.inputTokens).toBe(5);
		expect(calls).toHaveLength(1);
		expect(calls[0].messages).toEqual([{ role: "user", content: "hello" }]);
	});
	it("does not call a counter for configurations that do not advertise it", async () => {
		const fetcher = vi.fn();
		const gateway = createGateway({
			fetch: fetcher as unknown as typeof fetch,
			providerConfigs: [
				{
					providerId: "vllm",
					baseUrl: "http://server/v1",
					options: {
						localInference: { ...settings, inputTokenCounting: false },
					},
					models: [{ id: "fixture", contextWindow: 100, maxOutputTokens: 20 }],
				},
			],
		});
		expect(
			await gateway.createAgentModel({ providerId: "vllm", modelId: "fixture" })
				.countInputTokens!({ messages: [], tools: [] }),
		).toBeUndefined();
		expect(fetcher).not.toHaveBeenCalled();
	});
});

it.each([
	"vllm",
	"llamacpp",
] as const)("streams %s through the real serializer, preserves final usage and disables summary thinking", async (providerId) => {
	const calls: { url: string; body: Record<string, unknown> }[] = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const payload = (await request.json()) as Record<string, unknown>;
		calls.push({ url: request.url, body: payload });
		if (request.url.endsWith("/tokenize")) return response(nativeCount(5));
		if (request.url.endsWith("/input_tokens"))
			return response({ input_tokens: 5, context_window: 100 });
		const chunks = [
			{
				id: "fixture",
				object: "chat.completion.chunk",
				created: 1,
				model: "fixture",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "hello" },
						finish_reason: null,
					},
				],
			},
			{
				id: "fixture",
				object: "chat.completion.chunk",
				created: 1,
				model: "fixture",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
			},
		];
		return new Response(
			chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
				"data: [DONE]\n\n",
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	}) as typeof fetch;
	const gateway = createGateway({
		fetch: fetcher,
		providerConfigs: [
			{
				providerId,
				baseUrl: "http://server/v1",
				options: { localInference: settings },
				models: [
					{
						id: "fixture",
						contextWindow: 100,
						maxOutputTokens: 20,
						capabilities: ["reasoning"],
					},
				],
			},
		],
	});
	const events = [];
	for await (const event of await gateway.stream({
		providerId,
		modelId: "fixture",
		messages: [
			{
				id: "message",
				createdAt: 0,
				role: "user",
				content: [{ type: "text", text: "hello" }],
			},
		],
		reasoning: { enabled: false },
		maxTokens: 20,
	}))
		events.push(event);
	expect(events).toContainEqual(
		expect.objectContaining({ type: "text-delta", text: "hello" }),
	);
	expect(events).toContainEqual(
		expect.objectContaining({
			type: "usage",
			usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2 }),
		}),
	);
	expect(events).toContainEqual(
		expect.objectContaining({ type: "finish", reason: "stop" }),
	);
	expect(calls).toHaveLength(2);
	expect(calls[0].body.messages).toEqual(calls[1].body.messages);
	expect(calls[0].body.chat_template_kwargs).toEqual(
		calls[1].body.chat_template_kwargs,
	);
	expect(calls[1].body).toMatchObject({
		reasoning_effort: "none",
		chat_template_kwargs: { enable_thinking: false, reasoning_effort: "none" },
	});
	expect(
		calls[1].body[
			providerId === "vllm"
				? "thinking_token_budget"
				: "reasoning_budget_tokens"
		],
	).toBe(0);
	expect(calls[1].body.stream_options).not.toHaveProperty(
		"continuous_usage_stats",
	);
	// Exercise the legacy ApiHandler bridge used by hosts as well as the AgentModel path.
	const handler = createGatewayApiHandler({
		providerId,
		modelId: "fixture",
		baseUrl: "http://server/v1",
		fetch: fetcher,
		localInference: settings,
		maxOutputTokens: 20,
		modelInfo: { id: "fixture", contextWindow: 100, maxTokens: 20 },
	});
	const chunks = [];
	for await (const chunk of handler.createMessage("", [
		{ role: "user", content: "hello" },
	]))
		chunks.push(chunk);
	expect(chunks).toContainEqual(
		expect.objectContaining({ type: "text", text: "hello" }),
	);
	expect(calls).toHaveLength(4);
	expect(calls[3].body).toMatchObject({ top_k: 20 });
});

it.each([
	true,
	false,
])("rejects unexpected native inference endpoints before any preflight call (count-only: %s)", async (countOnly) => {
	const delegate = vi.fn() as unknown as typeof fetch;
	const transport = createInputTokenCountFetch(
		delegate,
		options.baseUrl,
		countOnly,
		() => {},
		options,
	);
	await expect(
		transport("http://unexpected.invalid/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	).rejects.toThrow("unexpected inference endpoint");
	await expect(
		transport("http://server/mount/v1/other", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	).rejects.toThrow("unexpected inference endpoint");
	expect(delegate).not.toHaveBeenCalled();
});
