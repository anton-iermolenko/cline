import type { MessageWithMetadata } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countUserRunMessages } from "../../session/user-run-messages";
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
	maxOutputTokens: 8192,
	knownModels: {
		local: {
			id: "local",
			contextWindow: 128192,
			maxInputTokens: 120000,
			maxTokens: 8192,
			metadata: { inputTokenCountUrl: "http://localhost/count" },
		},
	},
};
function input(signal = new AbortController().signal) {
	const messages: MessageWithMetadata[] = [
		buildSummaryMessage({
			summary: "Old checkpoint evidence ".repeat(800),
			fileOps: { readFiles: [], modifiedFiles: [] },
			tokensBefore: 100000,
			userRunSpan: 2,
		}),
		{
			id: "first",
			role: "user",
			content: "  Keep the existing API and whitespace.\n",
		},
		...Array.from({ length: 6 }, (_, i) => ({
			id: `step-${i}`,
			role: "assistant" as const,
			content: `BEGIN-${i} ` + "evidence ".repeat(3000) + ` END-${i}`,
		})),
		{
			id: "latest",
			role: "user",
			content: "Keep my current instruction verbatim.",
		},
		{ role: "assistant", content: "Latest live response" },
	];
	return {
		context: {
			agentId: "test",
			conversationId: "test",
			parentAgentId: null,
			iteration: 1,
			mode: "auto",
			model: {
				id: "local",
				provider: "openai-compatible",
				info: providerConfig.knownModels.local,
			},
			messages,
			budget: {
				request: {
					inputTokens: 180000,
					maxInputTokens: 120000,
					triggerTokens: 119872,
					targetTokens: 35000,
					summaryTokens: 8192,
					overheadTokens: 1000,
					thresholdRatio: 0.99,
					utilizationRatio: 1.5,
				},
				messages: {
					inputTokens: 179000,
					triggerTokens: 118872,
					targetTokens: 34000,
				},
			},
			abortSignal: signal,
		} satisfies CoreCompactionContext,
		providerConfig,
		preserveRecentTokens: 1,
		estimateMessageTokens: createTokenEstimator(),
	};
}
function count(
	request: { messages: { content: { text: string }[] }[] },
	limit = 120000,
) {
	return {
		inputTokens: request.messages.reduce(
			(sum, message) =>
				sum + message.content.map((part) => part.text).join("").length,
			0,
		),
		maxInputTokens: limit,
	};
}
function generationRequests(): string[] {
	return mocks.generate.mock.calls.map(([, messages]) => messages[0].content);
}
describe("measured summary checkpoints", () => {
	beforeEach(() => {
		mocks.count
			.mockReset()
			.mockImplementation(async (request) => count(request));
		let index = 0;
		mocks.generate.mockReset().mockImplementation(async function* () {
			yield {
				type: "text",
				text: `UNIQUE-NOTE-${++index}: confirmed evidence.`,
			};
			yield { type: "done", success: true };
		});
	});
	it("uses 40% of input capacity and carries every earlier addition unchanged", async () => {
		const options = input();
		const original = JSON.stringify(options.context.messages);
		const result = await runAgenticCompaction(options);
		const requests = generationRequests();
		expect(requests.length).toBeGreaterThan(2);
		for (let i = 0; i < requests.length; i++) {
			expect(requests[i].length).toBeLessThanOrEqual(48000);
			for (let prior = 1; prior <= i; prior++)
				expect(requests[i]).toContain(
					`UNIQUE-NOTE-${prior}: confirmed evidence.`,
				);
			if (i) expect(requests[i]).toContain("Do not restate or rewrite");
		}
		const summary = result!.messages[0].metadata!.summary as string;
		for (let i = 1; i <= requests.length; i++)
			expect(summary).toContain(`UNIQUE-NOTE-${i}: confirmed evidence.`);
		expect(requests.some((r) => r.length > 24000)).toBe(true);
		expect(JSON.stringify(options.context.messages)).toBe(original);
		// Every original message is included whole in exactly one conversation batch.
		for (let i = 0; i < 6; i++) {
			const containing = requests.filter((r) => r.includes(`BEGIN-${i}`));
			expect(containing).toHaveLength(1);
			expect(containing[0]).toContain(`END-${i}`);
		}
	});
	it("uses every earlier addition as a native vLLM assistant prefill and counts the exact prefix", async () => {
		const options = input();
		options.providerConfig = { ...options.providerConfig, providerId: "vllm" };
		await runAgenticCompaction(options);
		const generations = mocks.generate.mock.calls;
		expect(generations.length).toBeGreaterThan(2);
		expect(generations[0][1]).toHaveLength(1);
		for (let i = 1; i < generations.length; i++) {
			const messages = generations[i][1];
			const heading = "## Summary of the next historical batch\n";
			const prefix =
				Array.from(
					{ length: i },
					(_, prior) =>
						(prior ? heading : "") +
						`UNIQUE-NOTE-${prior + 1}: confirmed evidence.`,
				).join("\n\n") +
				"\n\n" +
				heading;
			expect(messages).toHaveLength(2);
			expect(messages[1]).toEqual({ role: "assistant", content: prefix });
			expect(messages[0].content).not.toContain("UNIQUE-NOTE-");
			expect(
				mocks.count.mock.calls.some(
					([request]) =>
						request.messages.at(-1)?.role === "assistant" &&
						request.messages.at(-1)?.content[0].text === prefix &&
						request.messages[0].content[0].text === messages[0].content,
				),
			).toBe(true);
		}
	});
	it.each([
		20000, 60000, 150000,
	])("scales batches down and up for a %i input allowance", async (limit) => {
		mocks.count.mockImplementation(async (request) => count(request, limit));
		const options = input();
		options.context.messages = [
			{ role: "user", content: "Preserve every result." },
			...Array.from({ length: 20 }, (_, i) => ({
				role: "assistant" as const,
				content: `Record ${i} ` + "x".repeat(4000),
			})),
			{ role: "assistant", content: "Recent" },
		];
		await runAgenticCompaction(options);
		for (const request of generationRequests())
			expect(request.length).toBeLessThanOrEqual(Math.floor(limit * 0.4));
	});
	it("includes past and latest user messages in the summary input and retains their originals once", async () => {
		const options = input();
		const humans = options.context.messages.filter(
			(m) => m.id === "first" || m.id === "latest",
		);
		const result = await runAgenticCompaction(options);
		const requests = generationRequests().join("\n");
		for (const human of humans) {
			expect(requests).toContain(human.content);
			expect(result!.messages.filter((m) => m.id === human.id)).toEqual([
				human,
			]);
		}
		expect(countUserRunMessages(result!.messages)).toBe(
			countUserRunMessages(options.context.messages),
		);
		const again = await runAgenticCompaction({
			...options,
			context: {
				...options.context,
				messages: [
					...result!.messages.slice(0, -1),
					{
						role: "assistant",
						content: "Additional completed work ".repeat(2000),
					},
					...result!.messages.slice(-1),
				],
			},
		});
		for (const human of humans)
			expect(again!.messages.filter((m) => m.id === human.id)).toEqual([human]);
		expect(countUserRunMessages(again!.messages)).toBe(
			countUserRunMessages(result!.messages),
		);
	});
	it("keeps full tool output and its call together, including evidence in the middle", async () => {
		const options = input();
		const output =
			"BEGIN-TOOL " +
			"a".repeat(6000) +
			"CRITICAL-MIDDLE-CONTRACT" +
			"z".repeat(6000) +
			" END-TOOL";
		options.context.messages.splice(
			2,
			0,
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "read-1",
						name: "read_files",
						input: { path: "contract.ts" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "read-1",
						name: "read_files",
						content: [{ type: "text", text: output }],
					},
				],
			},
		);
		await runAgenticCompaction(options);
		const requests = generationRequests().filter((r) =>
			r.includes("BEGIN-TOOL"),
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(output);
		expect(requests[0]).toContain("[Bot tool calls]: read_files");
	});
	it("keeps an oversized message intact when it fits the hard input allowance", async () => {
		const options = input();
		options.context.messages = [
			{
				role: "assistant",
				content: "BEGIN-OVERSIZED " + "x".repeat(60000) + " END-OVERSIZED",
			},
			{ role: "assistant", content: "Recent" },
		];
		await runAgenticCompaction(options);
		expect(generationRequests()[0]).toContain(
			options.context.messages[0].content,
		);
		expect(generationRequests()[0].length).toBeGreaterThan(48000);
		expect(generationRequests()[0].length).toBeLessThan(120000);
	});
	it("rejects an indivisible message above the hard limit without generating or mutating history", async () => {
		const options = input();
		options.context.messages[2].content = "x".repeat(130000);
		const original = JSON.stringify(options.context.messages);
		await expect(runAgenticCompaction(options)).rejects.toThrow(
			"intact message/tool exchange",
		);
		expect(JSON.stringify(options.context.messages)).toBe(original);
		expect(
			generationRequests().every((r) => !r.includes("x".repeat(1000))),
		).toBe(true);
	});
	it("compresses only after all additions exceed the summary quota and verifies the result", async () => {
		let index = 0;
		mocks.generate.mockImplementation(async function* (_system, messages) {
			const request = messages[0].content as string;
			yield {
				type: "text",
				text: request.startsWith("Compress the complete")
					? "Compressed notes retaining important evidence."
					: `NOTE-${++index} ` + "z".repeat(2200),
			};
			yield { type: "done", success: true };
		});
		const options = input();
		options.context.budget.request.summaryTokens = 4000;
		const result = await runAgenticCompaction(options);
		const requests = generationRequests();
		const compression = requests.at(-1)!;
		expect(compression).toMatch(
			/^Compress the complete continuation notes below to at most \d+ characters/,
		);
		for (let i = 1; i <= index; i++) expect(compression).toContain(`NOTE-${i}`);
		expect(result!.messages[0].metadata!.summary).toContain("Compressed notes");
		expect(
			requests.filter((r) => r.startsWith("Compress the complete")),
		).toHaveLength(1);
	});
	it("rejects a compressor that keeps exceeding quota after bounded retries", async () => {
		mocks.generate.mockImplementation(async function* () {
			yield { type: "text", text: "Large notes ".repeat(500) };
			yield { type: "done", success: true };
		});
		const options = input();
		options.context.budget.request.summaryTokens = 2000;
		await expect(runAgenticCompaction(options)).rejects.toThrow(
			"could not fit its token quota",
		);
		expect(
			generationRequests().filter((r) => r.startsWith("Compress the complete")),
		).toHaveLength(3);
	});
	it.each([
		"empty",
		"incomplete",
	])("rejects an %s checkpoint without changing context", async (failure) => {
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
	it("retries a complete empty checkpoint once with the identical request", async () => {
		let attempt = 0;
		mocks.generate.mockImplementation(async function* () {
			yield {
				type: "text",
				text: ++attempt === 1 ? "   " : "Recovered checkpoint.",
			};
			yield { type: "done", success: true };
		});
		await runAgenticCompaction(input());
		expect(mocks.generate.mock.calls[0]).toEqual(mocks.generate.mock.calls[1]);
	});
	it("makes exactly two attempts for an empty first checkpoint", async () => {
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
	it("does not generate after cancellation during counting", async () => {
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
	it("rejects a changing input allowance", async () => {
		let index = 0;
		mocks.count.mockImplementation(async (request) =>
			count(request, ++index === 1 ? 120000 : 100000),
		);
		await expect(runAgenticCompaction(input())).rejects.toThrow(
			"input allowance changed",
		);
		expect(mocks.generate).not.toHaveBeenCalled();
	});
});
