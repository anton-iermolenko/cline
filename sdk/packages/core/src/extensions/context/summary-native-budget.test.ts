import { createHandlerAsync } from "@cline/llms";
import { expect, it } from "vitest";
import { createAgentModelFromConfig } from "../../services/llms/handler-factory";
import { resolveSummarizerConfig } from "./compaction-shared";
import { generateSummary } from "./summary-generation";

it.each([
	"vllm",
	"llamacpp",
])("sends independent normal and summary output budgets through the real %s handler", async (providerId) => {
	const bodies: Record<string, unknown>[] = [];
	const fetcher = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const path = new URL(request.url).pathname;
		if (path.endsWith("/tokenize"))
			return Response.json({
				count: 40,
				tokens: Array(40).fill(1),
				max_model_len: 150000,
			});
		if (path.endsWith("/input_tokens"))
			return Response.json({ input_tokens: 40, context_window: 150000 });
		bodies.push((await request.json()) as Record<string, unknown>);
		return new Response(
			'data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"fixture","choices":[{"index":0,"delta":{"content":"summary"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	}) as typeof fetch;
	const normal = {
		providerId,
		modelId: "fixture",
		baseUrl: "http://fixture/v1",
		fetch: fetcher,
		maxOutputTokens: 8000,
		localInference: {
			contextWindow: 150000,
			maxOutputTokens: 8000,
			compaction: { targetTokens: 121871, summaryTokens: 16000 },
			thinking: true,
			thinkingBudgetTokens: 2000,
		},
		modelInfo: { id: "fixture", contextWindow: 150000, maxTokens: 8000 },
		knownModels: {
			fixture: { id: "fixture", contextWindow: 150000, maxTokens: 8000 },
		},
	};
	const summary = resolveSummarizerConfig({
		activeProviderConfig: normal,
		summaryTokens: 16000,
	});
	for (const config of [normal, summary]) {
		const handler = await createHandlerAsync(config);
		for await (const _chunk of handler.createMessage("Instructions", [
			{ role: "user", content: "History" },
		])) {
		}
	}
	expect(bodies).toHaveLength(2);
	expect(bodies[0].max_tokens).toBe(8000);
	expect(bodies[1].max_tokens).toBe(16000);
	expect(
		bodies[1][
			providerId === "vllm"
				? "thinking_token_budget"
				: "reasoning_budget_tokens"
		],
	).toBe(0);
	expect(normal.modelInfo.maxTokens).toBe(8000);
	expect(normal.knownModels.fixture.maxTokens).toBe(8000);
	expect(normal.localInference.thinking).toBe(true);
	expect(normal.localInference.compaction.targetTokens).toBe(121871);
	expect(summary.localInference?.compaction?.targetTokens).toBeUndefined();
});

it("reserves summary output independently when native counting is unavailable", () => {
	const normal = {
		providerId: "vllm",
		modelId: "fixture",
		maxOutputTokens: 8000,
		maxInputTokens: 142000,
		localInference: {
			contextWindow: 150000,
			maxOutputTokens: 8000,
			inputTokenCounting: false,
		},
		modelInfo: {
			id: "fixture",
			contextWindow: 150000,
			maxTokens: 8000,
			maxInputTokens: 142000,
		},
	};
	const summary = resolveSummarizerConfig({
		activeProviderConfig: normal,
		summaryTokens: 16000,
	});
	expect(summary.maxInputTokens).toBe(134000);
	expect(summary.modelInfo?.maxInputTokens).toBe(134000);
	expect(summary.knownModels?.fixture.maxInputTokens).toBe(134000);
	expect(normal.maxInputTokens).toBe(142000);
});

it("counts and generates the identical assistant prefix through the real native vLLM transports", async () => {
	const counted: Record<string, unknown>[] = [],
		generated: Record<string, unknown>[] = [];
	const fetcher = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const body = (await request.json()) as Record<string, unknown>;
		if (new URL(request.url).pathname.endsWith("/tokenize")) {
			counted.push(body);
			return Response.json({
				count: 40,
				tokens: Array(40).fill(1),
				max_model_len: 150000,
			});
		}
		generated.push(body);
		return new Response(
			'data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"fixture","choices":[{"index":0,"delta":{"content":"Additional evidence."},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	}) as typeof fetch;
	const config = resolveSummarizerConfig({
		activeProviderConfig: {
			providerId: "vllm",
			modelId: "fixture",
			baseUrl: "http://fixture/v1",
			fetch: fetcher,
			maxOutputTokens: 8000,
			localInference: {
				contextWindow: 150000,
				maxOutputTokens: 8000,
				thinking: false,
			},
			modelInfo: { id: "fixture", contextWindow: 150000, maxTokens: 8000 },
			knownModels: {
				fixture: { id: "fixture", contextWindow: 150000, maxTokens: 8000 },
			},
		},
		summaryTokens: 14000,
	});
	const prefix = "First pass facts.\n\nSecond pass facts.\n\n";
	const system = "Continue the summary.",
		request = "New historical messages.";
	const counter = createAgentModelFromConfig(
		{
			providerId: config.providerId,
			modelId: config.modelId,
			providerConfig: { ...config, continueAssistantMessage: true },
			systemPrompt: system,
			tools: [],
		},
		undefined,
	);
	const measurement = await counter.countInputTokens?.({
		systemPrompt: system,
		messages: [
			{
				id: "new",
				role: "user",
				createdAt: 0,
				content: [{ type: "text", text: request }],
			},
			{
				id: "prefix",
				role: "assistant",
				createdAt: 0,
				content: [{ type: "text", text: prefix }],
			},
		],
		tools: [],
		signal: new AbortController().signal,
		options: { maxTokens: 14000, thinking: false },
	});
	const result = await generateSummary({
		providerConfig: config,
		systemPrompt: system,
		request,
		assistantPrefill: prefix,
	});
	expect(measurement?.inputTokens).toBe(40);
	expect(result.text).toBe("Additional evidence.");
	expect(generated).toHaveLength(1);
	const wire = generated[0];
	expect(wire.continue_final_message).toBe(true);
	expect(wire.add_generation_prompt).toBe(false);
	expect(wire.max_tokens).toBe(14000);
	expect((wire.messages as { role: string; content: string }[]).at(-1)).toEqual(
		{ role: "assistant", content: prefix },
	);
	expect(counted).toHaveLength(2);
	for (const body of counted) {
		expect(body.messages).toEqual(wire.messages);
		expect(body.continue_final_message).toBe(true);
		expect(body.add_generation_prompt).toBe(false);
	}
	expect(config.continueAssistantMessage).toBeUndefined();
});
