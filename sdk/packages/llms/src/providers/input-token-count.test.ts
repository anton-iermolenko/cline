import { describe, expect, it, vi } from "vitest";
import { createGateway } from "./gateway";
import {
	createInputTokenCountFetch,
	parseInputTokenCount,
} from "./input-token-count";

const measurement = {
	inputTokens: 26763,
	source: "tokenized" as const,
	fingerprint: "prompt",
	budgetRevision: "config",
	contextWindow: 81920,
	maxInputTokens: 73727,
	maxOutputTokens: 8192,
	compactionBufferTokens: 2048,
	serverBoundaryTokens: 1,
};
function model(
	fetch: typeof globalThis.fetch,
	endpoint: string | null = "http://localhost/v1/chat/completions/input_tokens",
) {
	return createGateway({
		providerConfigs: [
			{
				providerId: "openai-compatible",
				baseUrl: "http://localhost/v1",
				apiKey: "fixture",
				fetch,
				models: [
					{
						id: "local",
						contextWindow: 81920,
						maxInputTokens: 73728,
						maxOutputTokens: 8192,
						capabilities: ["tools"],
						metadata: endpoint ? { inputTokenCountUrl: endpoint } : {},
					},
				],
			},
		],
	}).createAgentModel({ providerId: "openai-compatible", modelId: "local" });
}
describe("real SDK input token counting", () => {
	it("serializes messages and tools once without sending inference or internal metadata", async () => {
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		const fetch = (async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return Response.json(measurement);
		}) as typeof globalThis.fetch;
		const request = {
			systemPrompt: "System",
			messages: [
				{
					id: "internal",
					createdAt: 0,
					role: "user",
					content: [{ type: "text" as const, text: "hello" }],
					metadata: { summary: "x".repeat(300000) },
				},
			],
			tools: [
				{
					name: "probe",
					description: "Tool schema",
					inputSchema: {
						type: "object",
						properties: { key: { type: "string" } },
					},
				},
			],
			options: { maxTokensPerTurn: 8192, thinking: false },
		};
		const before = JSON.stringify(request);
		const count = await model(fetch).countInputTokens?.(request);
		expect(count).toEqual(measurement);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			"http://localhost/v1/chat/completions/input_tokens",
		);
		expect(calls[0].body.max_tokens).toBe(8192);
		expect(calls[0].body.tools).toHaveLength(1);
		expect(JSON.stringify(calls[0].body)).not.toContain("metadata");
		expect(JSON.stringify(calls[0].body)).not.toContain("internal");
		expect(JSON.stringify(request)).toBe(before);
	});
	it("never invokes unsupported provider transports for a count", async () => {
		const fetch = vi.fn(() => {
			throw new Error("Inference must not run");
		}) as unknown as typeof globalThis.fetch;
		expect(
			await model(fetch, null).countInputTokens?.({ messages: [], tools: [] }),
		).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("does not retry an unavailable count endpoint", async () => {
		const fetch = vi.fn(
			async () => new Response("unavailable", { status: 503 }),
		) as unknown as typeof globalThis.fetch;
		await expect(
			model(fetch).countInputTokens?.({
				messages: [
					{
						id: "message",
						createdAt: 0,
						role: "user",
						content: [{ type: "text", text: "hello" }],
					},
				],
				tools: [],
			}),
		).rejects.toThrow("Input token counting unavailable");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("rejects inconsistent budgets and invalid count data", () => {
		expect(() =>
			parseInputTokenCount({ ...measurement, inputTokens: NaN }),
		).toThrow();
		expect(() =>
			parseInputTokenCount({ ...measurement, maxInputTokens: 81920 }),
		).toThrow("inconsistent limits");
	});
	it("refuses cross-origin serialization-only requests", async () => {
		const fetch = vi.fn() as unknown as typeof globalThis.fetch;
		const capture = createInputTokenCountFetch(
			fetch,
			"http://localhost/v1/chat/completions/input_tokens",
			true,
			() => {},
		);
		await expect(
			capture("http://remote.invalid/v1/chat/completions", {
				method: "POST",
				body: "{}",
			}),
		).rejects.toThrow("unexpected inference endpoint");
		expect(fetch).not.toHaveBeenCalled();
	});
});
