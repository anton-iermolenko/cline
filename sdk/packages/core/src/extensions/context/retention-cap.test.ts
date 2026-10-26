import type {
	MessageWithMetadata,
	RequestInputTokenCount,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import type { CoreCompactionContext } from "../../types/config";
import {
	createContextCompactionPrepareTurn,
	type ContextPipelinePrepareTurnInput,
} from "./compaction";

const prompt: MessageWithMetadata = {
	role: "user",
	content: "Keep this user request verbatim.",
};
const original: MessageWithMetadata[] = [
	{ role: "assistant", content: "Earlier completed work ".repeat(20000) },
	prompt,
];
const measurement = (inputTokens: number): RequestInputTokenCount => ({
	inputTokens,
	source: "tokenized",
	fingerprint: "test",
	budgetRevision: "test",
	contextWindow: 163840,
	maxInputTokens: 155439,
	maxOutputTokens: 8400,
	compactionBufferTokens: 2048,
	serverBoundaryTokens: 1,
});
function turn(
	counter: ContextPipelinePrepareTurnInput["countRequestInputTokens"],
	notices = vi.fn(),
): ContextPipelinePrepareTurnInput {
	return {
		agentId: "test",
		conversationId: "test",
		parentAgentId: null,
		iteration: 1,
		messages: original,
		apiMessages: original,
		systemPrompt: "System",
		tools: [],
		model: {
			id: "local",
			provider: "openai",
			info: {
				id: "local",
				contextWindow: 163840,
				maxInputTokens: 155439,
				maxTokens: 8400,
			},
		},
		abortSignal: new AbortController().signal,
		countRequestInputTokens: counter,
		emitStatusNotice: notices,
	};
}

describe("compaction maximum retention cap", () => {
	it.each([
		"auto",
		"manual",
	] as const)("clamps a %s default target to the configured maximum", async (mode) => {
		const compact = vi.fn(async (_context: CoreCompactionContext) => ({
			messages: [prompt],
		}));
		const prepare = createContextCompactionPrepareTurn(
			{
				providerId: "openai",
				modelId: "local",
				compaction: { enabled: true, maxTargetTokens: 50000, compact },
			},
			{ mode },
		)!;
		await prepare(
			turn(async (messages) =>
				measurement(messages === original ? 154000 : 40000),
			),
		);
		expect(compact.mock.calls[0][0].budget.request.targetTokens).toBe(50000);
		expect(
			compact.mock.calls[0][0].budget.messages.targetTokens,
		).toBeLessThanOrEqual(50000);
	});

	it("rejects a measured candidate above the cap even when it fits the default preference and context window", async () => {
		const compact = vi.fn(async () => ({ messages: [prompt] }));
		const notices = vi.fn();
		const before = JSON.stringify(original);
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: { enabled: true, maxTargetTokens: 50000, compact },
		})!;
		await expect(
			prepare(
				turn(
					async (messages) =>
						measurement(messages === original ? 154000 : 55000),
					notices,
				),
			),
		).rejects.toThrow(/Original context was preserved/);
		expect(
			notices.mock.calls.some(([, value]) => value.phase === "completed"),
		).toBe(false);
		expect(JSON.stringify(original)).toBe(before);
	});

	it("allows a measured automatic result above the preference within the maximum", async () => {
		const compact = vi.fn(async () => ({ messages: [prompt] }));
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: {
				enabled: true,
				targetTokens: 65000,
				maxTargetTokens: 100000,
				compact,
			},
		})!;
		expect(
			(
				await prepare(
					turn(async (messages) =>
						measurement(messages === original ? 154000 : 80000),
					),
				)
			)?.messages,
		).toEqual([prompt]);
	});

	it("enforces the full-request maximum for an estimated custom result without invoking inference", async () => {
		const compact = vi.fn(async () => ({
			messages: [
				{
					role: "assistant" as const,
					content: "Oversized retained evidence ".repeat(1000),
				},
				prompt,
			],
		}));
		const notices = vi.fn();
		const before = JSON.stringify(original);
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai",
			modelId: "local",
			compaction: {
				enabled: true,
				targetTokens: 800,
				maxTargetTokens: 1000,
				compact,
			},
		})!;
		await expect(prepare(turn(async () => undefined, notices))).rejects.toThrow(
			/configured maximum/,
		);
		expect(
			notices.mock.calls.some(([, value]) => value.phase === "completed"),
		).toBe(false);
		expect(JSON.stringify(original)).toBe(before);
	});
});
