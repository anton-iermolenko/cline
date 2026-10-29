import type { MessageWithMetadata } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreCompactionContext } from "../../types/config";
import { runAgenticCompaction } from "./agentic-compaction";
import { createTokenEstimator } from "./compaction-shared";

const handler = vi.hoisted(() => ({ createMessage: vi.fn() }));
vi.mock("@cline/llms", () => ({ createHandlerAsync: async () => handler }));

const estimate = createTokenEstimator();
const prompt: MessageWithMetadata = {
	role: "user",
	content: "Preserve this instruction verbatim.",
};
const history: MessageWithMetadata[] = [
	prompt,
	...Array.from({ length: 100 }, (_, i) => ({
		role: "assistant" as const,
		content: `Completed step ${i}: ${"evidence ".repeat(330)}`,
	})),
];

function context(
	target: number,
	overhead: number,
	messages = history,
): CoreCompactionContext {
	return {
		agentId: "test",
		conversationId: "test",
		parentAgentId: null,
		iteration: 1,
		messages,
		mode: "auto",
		abortSignal: new AbortController().signal,
		model: {
			id: "mock",
			provider: "anthropic",
			info: { id: "mock", maxInputTokens: 155439 },
		},
		budget: {
			request: {
				inputTokens: 154000,
				maxInputTokens: 155439,
				triggerTokens: 153391,
				targetTokens: target,
				overheadTokens: overhead,
				thresholdRatio: 0.98,
				utilizationRatio: 0.99,
			},
			messages: {
				inputTokens: 150000,
				triggerTokens: 153391 - overhead,
				targetTokens: target - overhead,
			},
		},
	};
}

async function retained(
	target = 65000,
	overhead = 5000,
	preserveRecentTokens?: number,
	summaryOutput = 8192,
) {
	const result = await runAgenticCompaction({
		context: context(target, overhead),
		providerConfig: {
			providerId: "anthropic",
			modelId: "mock",
			maxOutputTokens: summaryOutput,
			modelInfo: { id: "mock", maxInputTokens: 155439 },
		},
		preserveRecentTokens,
		estimateMessageTokens: estimate,
	});
	expect(result?.messages).toContain(prompt);
	const tail = result!.messages.filter((m) => m.role === "assistant");
	return { tail, tokens: tail.reduce((n, m) => n + estimate(m), 0) };
}

describe("target-derived agentic retention", () => {
	beforeEach(() => {
		handler.createMessage.mockReset().mockImplementation(async function* () {
			yield {
				type: "text",
				text: "Completed earlier steps; continue the current instruction.",
			};
			yield { type: "done", success: true };
		});
	});

	it("keeps over 50K of recent history for a 65K preference instead of the fixed 20K suffix", async () => {
		const result = await retained();
		expect(result.tokens).toBeGreaterThan(51000);
		expect(result.tokens).toBeLessThan(53000);
		expect(result.tail.at(-1)).toBe(history.at(-1));
	});

	it("scales retention with the preferred target", async () => {
		const small = await retained(35000);
		const large = await retained(65000);
		expect(large.tokens - small.tokens).toBeGreaterThan(29000);
		expect(large.tokens - small.tokens).toBeLessThan(31000);
	});

	it("reserves space for request overhead and the summarizer output allowance", async () => {
		const baseline = await retained();
		const largerOverhead = await retained(65000, 14000);
		const largerSummary = await retained(65000, 5000, undefined, 12000);
		expect(baseline.tokens - largerOverhead.tokens).toBeGreaterThan(8000);
		expect(baseline.tokens - largerOverhead.tokens).toBeLessThan(10000);
		expect(baseline.tokens - largerSummary.tokens).toBeGreaterThan(3000);
	});

	it("honors a smaller explicit suffix and clamps a larger override to the preference", async () => {
		expect((await retained(65000, 5000, 12000)).tokens).toBeLessThan(14000);
		expect((await retained(65000, 5000, 100000)).tail).toEqual(
			(await retained()).tail,
		);
	});

	it("reserves and retains every original human input outside the recent suffix", async () => {
		const first = { role: "user" as const, content: "  First constraint.\n" };
		const second = {
			role: "user" as const,
			content: "Second correction. " + "context ".repeat(1200),
		};
		const messages = [
			first,
			...history.slice(1, 50),
			second,
			...history.slice(50),
		];
		const result = await runAgenticCompaction({
			context: context(65000, 5000, messages),
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock",
				modelInfo: { id: "mock", maxInputTokens: 155439 },
			},
			estimateMessageTokens: estimate,
		});
		expect(result!.messages.filter((m) => m === first)).toHaveLength(1);
		expect(result!.messages.filter((m) => m === second)).toHaveLength(1);
		const tokens = result!.messages.reduce(
			(total, message) => total + estimate(message),
			0,
		);
		expect(tokens).toBeLessThan(61000);
	});

	it("keeps a tool result with its assistant call when the pair crosses the retention boundary", async () => {
		const call: MessageWithMetadata = {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "read-1",
					name: "read_file",
					input: { path: "evidence.txt" },
				},
			],
		};
		const result: MessageWithMetadata = {
			role: "user",
			content: [
				{
					type: "tool_result",
					name: "read_file",
					tool_use_id: "read-1",
					content: "evidence ".repeat(500),
				},
			],
		};
		const compacted = await runAgenticCompaction({
			context: context(65000, 5000, [...history, call, result]),
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock",
				modelInfo: { id: "mock", maxInputTokens: 155439 },
			},
			preserveRecentTokens: 1,
			estimateMessageTokens: estimate,
		});
		expect(compacted?.messages).toContain(call);
		expect(compacted?.messages).toContain(result);
		expect(compacted?.messages.indexOf(call)).toBeLessThan(
			compacted!.messages.indexOf(result),
		);
	});
});
