import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreCompactionContext } from "../../types/config";
import { runAgenticCompaction } from "./agentic-compaction";
import { buildSummaryMessage, createTokenEstimator } from "./compaction-shared";

const mocks = vi.hoisted(() => ({ count: vi.fn(), generate: vi.fn() }));
vi.mock("../../services/llms/handler-factory", () => ({
	createAgentModelFromConfig: () => ({ countInputTokens: mocks.count }),
}));
vi.mock("@cline/llms", () => ({
	createHandlerAsync: async () => ({ createMessage: mocks.generate }),
}));
const providerConfig = {
	providerId: "openai-compatible",
	modelId: "local",
	knownModels: {
		local: {
			id: "local",
			contextWindow: 81920,
			maxInputTokens: 73728,
			maxTokens: 8192,
			metadata: { inputTokenCountUrl: "http://localhost/count" },
		},
	},
};
function input(signal = new AbortController().signal) {
	const checkpoint = buildSummaryMessage({
		summary: "Old checkpoint evidence ".repeat(14000),
		fileOps: { readFiles: [], modifiedFiles: [] },
		tokensBefore: 100000,
		userRunSpan: 1,
	});
	const messages = [
		checkpoint,
		{ role: "assistant" as const, content: "Additional work".repeat(3000) },
		{ role: "user" as const, content: "Keep my current instruction verbatim." },
		{ role: "assistant" as const, content: "Latest live response" },
	];
	return {
		context: {
			messages,
			budget: {
				request: {
					inputTokens: 110000,
					maxInputTokens: 73727,
					triggerTokens: 71679,
				},
			},
			abortSignal: signal,
		} as CoreCompactionContext,
		providerConfig,
		preserveRecentTokens: 1,
		estimateMessageTokens: createTokenEstimator(),
	};
}
function count(request: { messages: { content: { text: string }[] }[] }) {
	return {
		inputTokens: request.messages[0].content[0].text.length,
		maxInputTokens: 73727,
	};
}
describe("measured summary checkpoints", () => {
	beforeEach(() => {
		mocks.count
			.mockReset()
			.mockImplementation(async (request) => count(request));
		mocks.generate
			.mockReset()
			.mockImplementation(async function* (_system, _messages) {
				yield { type: "text", text: "Approved checkpoint and next steps." };
				yield { type: "done", success: true };
			});
	});
	it("refolds a large old checkpoint in bounded measured chunks and preserves the current instruction", async () => {
		const options = input();
		const original = JSON.stringify(options.context.messages);
		const result = await runAgenticCompaction(options);
		expect(mocks.generate.mock.calls.length).toBeGreaterThan(1);
		for (const [, messages] of mocks.generate.mock.calls)
			expect(messages[0].content.length).toBeLessThanOrEqual(24000);
		expect(
			mocks.generate.mock.calls.some(([, messages]) =>
				messages[0].content.includes("Old checkpoint evidence"),
			),
		).toBe(true);
		expect(
			result?.messages.some(
				(message) =>
					message.content === "Keep my current instruction verbatim.",
			),
		).toBe(true);
		expect(JSON.stringify(options.context.messages)).toBe(original);
		const again = await runAgenticCompaction({
			...options,
			context: {
				...options.context,
				messages: [
					...result!.messages.slice(0, 1),
					{ role: "assistant", content: "New evidence".repeat(10000) },
					...result!.messages.slice(1),
				],
			},
		});
		expect(
			again?.messages.some(
				(message) =>
					message.content === "Keep my current instruction verbatim.",
			),
		).toBe(true);
	});
	it.each([
		"empty",
		"incomplete",
	])("rejects an %s generated checkpoint without changing context", async (failure) => {
		mocks.generate.mockImplementation(async function* () {
			yield { type: "text", text: failure === "empty" ? "" : "Partial" };
			yield {
				type: "done",
				success: true,
				incompleteReason:
					failure === "incomplete" ? "max_output_tokens" : undefined,
			};
		});
		const options = input();
		const original = JSON.stringify(options.context.messages);
		await expect(runAgenticCompaction(options)).rejects.toThrow(
			"empty or incomplete",
		);
		expect(JSON.stringify(options.context.messages)).toBe(original);
	});

	it("retries a complete empty checkpoint once using the identical chunk", async () => {
		let attempt = 0;
		mocks.generate.mockImplementation(async function* () {
			yield {
				type: "text",
				text: ++attempt === 1 ? "   " : "Recovered checkpoint.",
			};
			yield { type: "done", success: true };
		});
		const options = input();
		const result = await runAgenticCompaction(options);
		expect(result?.messages.length).toBeGreaterThan(0);
		expect(mocks.generate.mock.calls[0]).toEqual(mocks.generate.mock.calls[1]);
	});
	it("makes exactly two generation attempts when the first chunk stays empty", async () => {
		mocks.generate.mockImplementation(async function* () {
			yield { type: "reasoning", reasoning: "A thought without a summary." };
			yield { type: "done", success: true };
		});
		await expect(runAgenticCompaction(input())).rejects.toThrow(
			"empty or incomplete",
		);
		expect(mocks.generate).toHaveBeenCalledTimes(2);
	});
	it("does not retry an incomplete checkpoint", async () => {
		mocks.generate.mockImplementation(async function* () {
			yield { type: "text", text: "Partial checkpoint" };
			yield {
				type: "done",
				success: true,
				incompleteReason: "max_output_tokens",
			};
		});
		await expect(runAgenticCompaction(input())).rejects.toThrow(
			"empty or incomplete",
		);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});
	it("does not retry after cancellation following an empty response", async () => {
		const abort = new AbortController();
		mocks.generate.mockImplementation(async function* () {
			yield { type: "text", text: "" };
			yield { type: "done", success: true };
			abort.abort();
		});
		await expect(
			runAgenticCompaction(input(abort.signal)),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});

	it("does not generate or commit after cancellation during counting", async () => {
		const abort = new AbortController();
		mocks.count.mockImplementation(async (request) => {
			abort.abort();
			return count(request);
		});
		await expect(
			runAgenticCompaction(input(abort.signal)),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(mocks.generate).not.toHaveBeenCalled();
	});
});
