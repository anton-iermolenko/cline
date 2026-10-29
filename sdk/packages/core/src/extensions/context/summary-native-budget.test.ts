import { createHandlerAsync } from "@cline/llms";
import { expect, it } from "vitest";
import { resolveSummarizerConfig } from "./compaction-shared";

it.each([
	"vllm",
	"llamacpp",
])("sends independent normal and summary output budgets through the real %s handler", async (providerId) => {
	const bodies: Record<string, unknown>[] = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
