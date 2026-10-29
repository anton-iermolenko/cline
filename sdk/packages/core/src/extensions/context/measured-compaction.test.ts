import type {
	MessageWithMetadata,
	RequestInputTokenCount,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { runBasicCompaction } from "./basic-compaction";
import {
	type ContextPipelinePrepareTurnInput,
	createContextCompactionPrepareTurn,
} from "./compaction";
import { createTokenEstimator, isTurnStartMessage } from "./compaction-shared";

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
	it("rejects a native candidate or fallback that changes an older original user input", async () => {
		const older: MessageWithMetadata = {
			id: "older",
			role: "user",
			content: "  Keep every original constraint.\n",
		};
		const original: MessageWithMetadata[] = [
			older,
			{ role: "assistant", content: "Completed work ".repeat(3000) },
			prompt,
		];
		const before = JSON.stringify(original);
		const prepare = createContextCompactionPrepareTurn({
			providerId: "vllm",
			modelId: "local",
			providerConfig: {
				providerId: "vllm",
				modelId: "local",
				localInference: { contextWindow: 81920, maxOutputTokens: 8192 },
			},
			compaction: {
				enabled: true,
				compact: async () => ({ messages: [prompt] }),
			},
		})!;
		await expect(
			prepare(
				turn(original, async (messages) =>
					measured(messages === original ? 72000 : 10000),
				),
			),
		).rejects.toThrow("protected_prompt_changed");
		expect(JSON.stringify(original)).toBe(before);
	});
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

describe("measured target and protected prompt regressions", () => {
	it.each([
		72000, 80000,
	])("keeps the latest request separate from older prompts at %i input tokens", async (inputTokens) => {
		const current: MessageWithMetadata = {
			id: "latest-request",
			role: "user",
			content: [
				{ type: "text", text: "  Keep whitespace and attachments.\n" },
				{
					type: "image",
					data: "aGVsbG8=",
					mediaType: "image/png",
				},
			],
		};
		const original: MessageWithMetadata[] = [
			{ id: "old-request", role: "user", content: "Previous instruction" },
			{ id: "old-work", role: "assistant", content: "x".repeat(250000) },
			current,
			{
				id: "new-work",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "read_files",
						input: { file_paths: ["report.md"] },
					},
				],
			},
			{
				id: "new-result",
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						name: "read_files",
						content: "y".repeat(1000000),
					},
				],
			},
		];
		const before = JSON.stringify(original);
		const notices = vi.fn();
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: { enabled: true, strategy: "basic" },
		})!;
		const result = await prepare(
			turn(
				original,
				async (messages) =>
					measured(messages === original ? inputTokens : 20000),
				notices,
			),
		);
		expect(
			result?.messages.find((message) => message.id === current.id)?.content,
		).toEqual(current.content);
		expect(
			result?.messages.slice().reverse().find(isTurnStartMessage)?.id,
		).toBe(current.id);
		expect(
			result?.messages.some(
				(message) => message.metadata?.kind === "compaction_work_summary",
			),
		).toBe(true);
		expect(JSON.stringify(original)).toBe(before);
		expect(
			notices.mock.calls.find(([, meta]) => meta.phase === "completed")?.[1],
		).toMatchObject({ tokensAfter: 20000 });
	});
	it("does not accept a candidate that shrinks below the hard limit but misses the target", async () => {
		const original: MessageWithMetadata[] = [
			{ role: "assistant", content: "x".repeat(250000) },
			prompt,
		];
		const notices = vi.fn();
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: {
				enabled: true,
				compact: async () => ({ messages: [prompt] }),
			},
		})!;
		await expect(
			prepare(
				turn(
					original,
					async (messages) => measured(messages === original ? 78000 : 60000),
					notices,
				),
			),
		).rejects.toThrow("target_not_reached");
		expect(
			notices.mock.calls.some(([, meta]) => meta.phase === "completed"),
		).toBe(false);
	});
	it("keeps reducing after a plateau until the full request reaches the target", async () => {
		const original: MessageWithMetadata[] = [
			prompt,
			{ id: "first", role: "assistant", content: "x".repeat(120000) },
			{ id: "last", role: "assistant", content: "y".repeat(60000) },
		];
		const candidate = [prompt, ...original.slice(1)];
		const counts: number[] = [];
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: {
				enabled: true,
				// Exercise the plateau independently of capacity-based default targets.
				targetTokens: 60000,
				compact: async () => ({ messages: candidate }),
			},
		})!;
		const result = await prepare(
			turn(original, async (messages) => {
				const value =
					messages === original
						? 80000
						: messages.some((m) => m.id === "last")
							? 65000
							: 18000;
				counts.push(value);
				return measured(value);
			}),
		);
		expect(
			counts.filter((value) => value === 65000).length,
		).toBeGreaterThanOrEqual(2);
		expect(counts.at(-1)).toBe(18000);
		expect(result?.messages.some((m) => m.id === "last")).toBe(false);
	});
	it("basic refolding preserves the protected prompt even when nothing else fits", () => {
		const current: MessageWithMetadata = {
			...prompt,
			id: "keep",
			content: [{ type: "text", text: " \n Exact prompt \n " }],
		};
		const context = turn(
			[current, { role: "assistant", content: "Old output" }],
			undefined,
		);
		const result = runBasicCompaction({
			context: {
				...context,
				mode: "auto",
				budget: {
					request: {
						inputTokens: 10000,
						maxInputTokens: 73727,
						triggerTokens: 71679,
						targetTokens: 1,
						overheadTokens: 0,
						thresholdRatio: 1,
						utilizationRatio: 1,
					},
					messages: {
						inputTokens: 10000,
						triggerTokens: 10000,
						targetTokens: 1,
					},
				},
			},
			estimateMessageTokens: createTokenEstimator(),
			refoldPreserved: true,
		});
		expect(result?.messages.find((m) => m.id === "keep")?.content).toEqual(
			current.content,
		);
		expect(
			result?.messages.slice().reverse().find(isTurnStartMessage)?.id,
		).toBe("keep");
	});
});

it("bounds dropped assistant output instead of reproducing it in fallback summaries", async () => {
	const messages: MessageWithMetadata[] = [
		{ ...prompt, id: "task" },
		{
			id: "huge-answer",
			role: "assistant",
			content: "Detailed output ".repeat(16000),
		},
	];
	const prepare = createContextCompactionPrepareTurn({
		providerId: "openai",
		modelId: "local",
		compaction: { enabled: true, strategy: "basic" },
	})!;
	const notices = vi.fn();
	const result = await prepare(
		turn(
			messages,
			async (candidate) =>
				measured(
					candidate.reduce(
						(sum, m) => sum + Math.ceil(JSON.stringify(m.content).length / 3),
						2000,
					),
				),
			notices,
		),
	);
	const started = notices.mock.calls.find(
		([, meta]) => meta.phase === "started",
	)?.[1];
	const completed = notices.mock.calls.find(
		([, meta]) => meta.phase === "completed",
	)?.[1];
	expect(completed.tokensAfter).toBeLessThanOrEqual(started.targetTokens);
	expect(result?.messages.find((m) => m.id === "task")?.content).toEqual(
		prompt.content,
	);
	expect(JSON.stringify(result?.messages)).toContain(
		"Earlier assistant response shortened during compaction",
	);
});
