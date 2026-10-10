import type {
	MessageWithMetadata,
	RequestInputTokenCount,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	type ContextPipelinePrepareTurnInput,
	createContextCompactionPrepareTurn,
} from "./compaction";

const measured = (tokens: number): RequestInputTokenCount => ({
	inputTokens: tokens,
	source: "tokenized",
	fingerprint: "prompt",
	budgetRevision: "profile",
	contextWindow: 81920,
	maxInputTokens: 73727,
	maxOutputTokens: 8192,
	compactionBufferTokens: 2048,
	serverBoundaryTokens: 1,
});
const prompt: MessageWithMetadata = {
	id: "current",
	role: "user",
	content: "Keep the current instruction verbatim.",
};
function turn(
	messages: MessageWithMetadata[],
	counter: ContextPipelinePrepareTurnInput["countRequestInputTokens"],
	notices = vi.fn(),
): ContextPipelinePrepareTurnInput {
	return {
		agentId: "test",
		conversationId: "test",
		parentAgentId: null,
		iteration: 1,
		messages,
		apiMessages: messages,
		systemPrompt: "System",
		tools: [],
		model: {
			id: "local",
			provider: "openai",
			info: {
				id: "local",
				contextWindow: 81920,
				maxInputTokens: 73728,
				maxTokens: 8192,
			},
		},
		abortSignal: new AbortController().signal,
		countRequestInputTokens: counter,
		emitStatusNotice: notices,
		previousRequestInputTokens: 80000,
	};
}
describe("measured compaction", () => {
	it("does not compact a measured 26K prompt because JSON or previous usage is large", async () => {
		const compact = vi.fn();
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: { enabled: true, compact },
		})!;
		const messages = [{ ...prompt, metadata: { summary: "x".repeat(300000) } }];
		expect(
			await prepare(turn(messages, async () => measured(26763))),
		).toBeUndefined();
		expect(compact).not.toHaveBeenCalled();
	});
	it("triggers at hard input minus 2048 and recounts the accepted result", async () => {
		const original = [
			{ role: "assistant" as const, content: "x".repeat(210000) },
			prompt,
		];
		const result = [{ role: "user" as const, content: "Checkpoint" }, prompt];
		const compact = vi.fn(
			async (_context: import("../../types/config").CoreCompactionContext) => ({
				messages: result,
			}),
		);
		const notices = vi.fn();
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: { enabled: true, compact },
		})!;
		const counter = vi.fn(async (messages: MessageWithMetadata[]) =>
			measured(messages === original ? 72000 : 26763),
		);
		const before = JSON.stringify(original);
		expect((await prepare(turn(original, counter, notices)))?.messages).toEqual(
			result,
		);
		expect(compact.mock.calls[0]?.[0]).toMatchObject({
			budget: { request: { maxInputTokens: 73727, triggerTokens: 71679 } },
		});
		expect(
			notices.mock.calls.find(([, meta]) => meta.phase === "completed")?.[1],
		).toMatchObject({
			tokensBefore: 72000,
			tokensAfter: 26763,
			countSource: "tokenized",
		});
		expect(JSON.stringify(original)).toBe(before);
	});
	it("preserves original context and emits no completion when candidate counting fails", async () => {
		const messages = [
			{ role: "assistant" as const, content: "Old work" },
			prompt,
		];
		const before = JSON.stringify(messages);
		const notices = vi.fn();
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: {
				enabled: true,
				compact: async () => ({ messages: [prompt] }),
			},
		})!;
		let calls = 0;
		await expect(
			prepare(
				turn(
					messages,
					async () => {
						if (++calls > 1) throw new Error("Counter unavailable");
						return measured(72000);
					},
					notices,
				),
			),
		).rejects.toThrow("Counter unavailable");
		expect(
			notices.mock.calls.some(([, meta]) => meta.phase === "completed"),
		).toBe(false);
		expect(JSON.stringify(messages)).toBe(before);
	});
	it("allows irreducible protected input below the hard limit without repeated compaction", async () => {
		const compact = vi.fn(async () => undefined);
		const notices = vi.fn();
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: { enabled: true, compact },
		})!;
		const input = turn([prompt], async () => measured(72000), notices);
		expect(await prepare(input)).toBeUndefined();
		expect(await prepare(input)).toBeUndefined();
		expect(compact).toHaveBeenCalledTimes(1);
		expect(
			notices.mock.calls.some(([, meta]) => meta.phase === "completed"),
		).toBe(false);
	});
	it("does not admit irreducible input above the hard limit", async () => {
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: { enabled: true, strategy: "basic" },
		})!;
		await expect(
			prepare(turn([prompt], async () => measured(75000))),
		).rejects.toThrow("hard input allowance");
	});
});
