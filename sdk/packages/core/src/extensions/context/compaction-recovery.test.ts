import assert from "node:assert/strict";
import type { MessageWithMetadata } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreCompactionContext } from "../../types/config";
import { runAgenticCompaction } from "./agentic-compaction";
import { createContextCompactionPrepareTurn } from "./compaction";
import {
	buildSummaryMessage,
	createTokenEstimator,
	isTurnStartMessage,
} from "./compaction-shared";

const createHandlerMock = vi.hoisted(() => vi.fn());
vi.mock("@cline/llms", () => ({
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
}));
const estimate = createTokenEstimator();
const total = (messages: MessageWithMetadata[]) =>
	messages.reduce((n, m) => n + estimate(m), 0);
const summary = () =>
	buildSummaryMessage({
		summary: "Keep the approved plan and validate the edited files.",
		fileOps: { readFiles: [], modifiedFiles: [] },
		tokensBefore: 10000,
		userRunSpan: 1,
	});
function toolPair(id: string, size: number): MessageWithMetadata[] {
	return [
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id,
					name: "read_files",
					input: { file_paths: ["/tmp/test.ts"] },
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: id,
					name: "read_files",
					content: "x".repeat(size),
				},
			],
		},
	];
}
function prepare(
	messages: MessageWithMetadata[],
	mode: "auto" | "manual" = "auto",
	strategy: "basic" | "agentic" = "agentic",
) {
	const handler = createContextCompactionPrepareTurn(
		{
			providerId: "openai",
			modelId: "local",
			compaction: { enabled: true, strategy, preserveRecentTokens: 200 },
		},
		{ mode },
	);
	assert(handler);
	return handler({
		agentId: "test",
		conversationId: "test",
		parentAgentId: null,
		iteration: 1,
		abortSignal: new AbortController().signal,
		systemPrompt: "",
		tools: [],
		messages,
		apiMessages: messages,
		model: {
			id: "local",
			provider: "openai",
			info: { id: "local", maxInputTokens: 2000, maxTokens: 1000 },
		},
	});
}
function mockSummary(text: string) {
	createHandlerMock.mockResolvedValue({
		async *createMessage() {
			if (text) yield { type: "text", text };
			yield { type: "done", success: true };
		},
	});
}
describe("summary-only compaction recovery", () => {
	beforeEach(() => {
		createHandlerMock.mockReset();
		mockSummary("");
	});
	it.each([
		"empty",
		"throw",
		"oversized",
	])("recovers after an agentic summary when the next summarizer is %s", async (failure) => {
		mockSummary("Keep the approved plan and validate the edited files.");
		const initial: MessageWithMetadata[] = [
			{ role: "user", content: "Follow the approved plan" },
			...toolPair("old", 18000),
			...toolPair("recent", 30),
		];
		const first = await runAgenticCompaction({
			context: {
				messages: initial,
				budget: { request: { maxInputTokens: 2000, triggerTokens: 1800 } },
			} as CoreCompactionContext,
			providerConfig: { providerId: "openai", modelId: "local" },
			preserveRecentTokens: 200,
			estimateMessageTokens: estimate,
		});
		assert(first?.messages);
		expect(first.messages.some(isTurnStartMessage)).toBe(false);
		const anchor = first.messages[0];
		if (failure === "throw")
			createHandlerMock.mockRejectedValue(new Error("summarizer unavailable"));
		else mockSummary(failure === "oversized" ? "s".repeat(18000) : "");
		const result = await prepare([
			...first.messages,
			...toolPair("large", 18000),
			...toolPair("latest", 30),
		]);
		assert(result?.messages);
		expect(total(result.messages)).toBeLessThan(1800);
		expect(result.messages[0]).toEqual(anchor);
		expect(result.messages.some(isTurnStartMessage)).toBe(false);
		const blocks = result.messages.flatMap((m) =>
			Array.isArray(m.content) ? m.content : [],
		);
		for (const block of blocks)
			if (block.type === "tool_result")
				expect(
					blocks.some(
						(b) => b.type === "tool_use" && b.id === block.tool_use_id,
					),
				).toBe(true);
	});
	it("bounds an oversized manual compaction instead of reporting an oversized summary as success", async () => {
		mockSummary("s".repeat(18000));
		const result = await prepare(
			[summary(), ...toolPair("large", 18000), ...toolPair("latest", 30)],
			"manual",
		);
		assert(result?.messages);
		expect(total(result.messages)).toBeLessThan(1800);
		expect(result.messages[0].metadata?.kind).toBe("compaction_summary");
	});
	it.each([
		"auto",
		"manual",
	] as const)("reports measured oversized summary in %s mode without erasing it", async (mode) => {
		const anchor = summary();
		anchor.content = "s".repeat(18000);
		await expect(
			prepare([anchor, ...toolPair("latest", 30)], mode, "basic"),
		).rejects.toThrow(
			/compaction threshold \(1800 tokens; input allowance 2000 tokens\).*Remaining message estimate/,
		);
	});
	it("distinguishes a missing fallback anchor from an oversized protected prompt", async () => {
		await expect(prepare(toolPair("large", 18000))).rejects.toThrow(
			"fallback returned no usable context",
		);
	});
});
