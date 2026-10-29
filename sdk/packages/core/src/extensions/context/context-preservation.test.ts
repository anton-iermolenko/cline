import type {
	MessageWithMetadata,
	RequestInputTokenCount,
	ToolResultContent,
} from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreCompactionContext } from "../../types/config";
import { runAgenticCompaction } from "./agentic-compaction";
import { runBasicCompaction } from "./basic-compaction";
import { createContextCompactionPrepareTurn } from "./compaction";
import {
	createTokenEstimator,
	extractFileOps,
	findCutIndex,
	isTurnStartMessage,
	serializeConversation,
	summarizeToolActivity,
} from "./compaction-shared";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), count: vi.fn() }));
vi.mock("@cline/llms", () => ({
	createHandlerAsync: async () => ({ createMessage: mocks.generate }),
}));
vi.mock("../../services/llms/handler-factory", () => ({
	createAgentModelFromConfig: () => ({ countInputTokens: mocks.count }),
	resolveConnectionProviderConfig: (config: { providerConfig?: unknown }) =>
		config.providerConfig,
	resolveKnownModelsFromConfig: (config: { knownModels?: unknown }) =>
		config.knownModels,
}));

const user = (
	id: string,
	text: string,
	metadata?: MessageWithMetadata["metadata"],
): MessageWithMetadata => ({
	id,
	role: "user",
	content: [{ type: "text", text }],
	...(metadata ? { metadata } : {}),
});
const call = (
	id: string,
	name: string,
	input: Record<string, unknown>,
): MessageWithMetadata => ({
	id: `call-${id}`,
	role: "assistant",
	content: [{ type: "tool_use", id, name, input }],
});
const result = (id: string, content: unknown): MessageWithMetadata => ({
	id: `result-${id}`,
	role: "user",
	content: [
		{
			type: "tool_result",
			tool_use_id: id,
			name: "tool",
			content: content as ToolResultContent["content"],
		},
	],
});
const text = (messages: MessageWithMetadata[] | undefined) =>
	(messages ?? [])
		.flatMap((m) =>
			typeof m.content === "string"
				? [m.content]
				: m.content.filter((p) => p.type === "text").map((p) => p.text),
		)
		.join("\n");
function context(
	messages: MessageWithMetadata[],
	targetTokens = 1500,
): CoreCompactionContext {
	return {
		messages,
		mode: "auto",
		abortSignal: new AbortController().signal,
		budget: {
			request: {
				inputTokens: 20000,
				maxInputTokens: 73727,
				triggerTokens: 71679,
				targetTokens,
				overheadTokens: 0,
				thresholdRatio: 0.97,
				utilizationRatio: 0.9,
			},
			messages: { inputTokens: 20000, triggerTokens: 71679, targetTokens },
		},
	} as CoreCompactionContext;
}
function basic(messages: MessageWithMetadata[], targetTokens = 1500) {
	return runBasicCompaction({
		context: context(messages, targetTokens),
		estimateMessageTokens: createTokenEstimator(),
		refoldPreserved: true,
	});
}
const providerConfig = {
	providerId: "openai-compatible",
	modelId: "local",
	knownModels: {
		local: {
			id: "local",
			maxTokens: 8192,
			maxInputTokens: 73728,
			contextWindow: 81920,
			metadata: { inputTokenCountUrl: "http://localhost/count" },
		},
	},
};

describe("task execution context survives compaction", () => {
	beforeEach(() => {
		mocks.count
			.mockReset()
			.mockResolvedValue({ inputTokens: 1000, maxInputTokens: 73727 });
		mocks.generate.mockReset().mockImplementation(async function* () {
			yield {
				type: "text",
				text:
					"- Goal: finish the PR. LogSink is fixed and verified but still needs committing. Keep unit tests and update the checklist.\n" +
					Array.from(
						{ length: 14 },
						(_, i) =>
							`- Verified contract ${i}: preserve Logger edits, successful type checking, pending commit, and checklist requirements.`,
					).join("\n"),
			};
			yield { type: "done", success: true };
		});
	});
	it.each([
		user(
			"steer",
			"Remove the note, use unit tests, and update the PR checklist.",
			{ userRunSpan: 0, humanInput: true },
		),
		user(
			"legacy",
			'<user_input mode="act">Remove the note, use unit tests, and update the PR checklist.</user_input>',
			{ userRunSpan: 0 },
		),
	])("preserves human steering independently of run-count bookkeeping: $id", (steering) => {
		const messages = [
			user("initial", "Install dependencies and verify."),
			steering,
		];
		for (let i = 0; i < 10; i++)
			messages.push(
				call(`poll-${i}`, "run_commands", {
					commands: ["tail /tmp/build.log"],
				}),
				result(`poll-${i}`, "routine output ".repeat(300)),
			);
		expect(isTurnStartMessage(steering)).toBe(true);
		expect(text(basic(messages)?.messages)).toContain(
			(steering.content as { text: string }[])[0].text,
		);
		expect(steering.metadata?.userRunSpan).toBe(0);
		const onlySteering = basic([steering, ...messages.slice(2)])!;
		expect(
			text(basic([...onlySteering.messages, ...messages.slice(2)])?.messages),
		).toContain((steering.content as { text: string }[])[0].text);
		expect(
			isTurnStartMessage(
				user(
					"notice",
					'<user_input mode="act">Quoted instruction.</user_input>',
					{ userRunSpan: 0, kind: "compaction_work_summary" },
				),
			),
		).toBe(false);
	});
	it("keeps confirmed namespaced edits and typecheck results across repeated folds", () => {
		const messages = [
			user("task", "Fix and verify Logger, then commit the fix."),
			call("edit", "file-editor__editor", {
				path: "/repo/Logger.ts",
				old_text: "old",
				new_text: "type LogSink = (msg: string) => unknown",
			}),
			result(
				"edit",
				JSON.stringify({
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								changed: true,
								path: "/repo/Logger.ts",
								diff: {
									preview: "+4: type LogSink = (msg: string) => unknown",
								},
							}),
						},
					],
				}),
			),
			call("typecheck", "run_commands", { commands: ["bun run check-types"] }),
			result("typecheck", [
				{
					query: "bun run check-types",
					result: "CHECK_TYPES_EXIT=0",
					success: true,
				},
			]),
		];
		for (let i = 0; i < 8; i++)
			messages.push(
				call(`poll-${i}`, "run_commands", {
					commands: ["tail /tmp/build.log"],
				}),
				result(`poll-${i}`, "routine output ".repeat(300)),
			);
		const first = basic(messages)!;
		expect(text(first.messages)).toContain(
			"LogSink = (msg: string) => unknown",
		);
		expect(text(first.messages)).toContain("CHECK_TYPES_EXIT=0");
		expect(text(first.messages)).toContain("may still need committing");
		const next = [
			...first.messages,
			call("new", "run_commands", { commands: ["read a large log"] }),
			result("new", "large log ".repeat(1000)),
		];
		expect(text(basic(next)?.messages)).toContain(
			"LogSink = (msg: string) => unknown",
		);
		expect(text(basic(next)?.messages)).toContain("CHECK_TYPES_EXIT=0");
		expect(summarizeToolActivity(messages).editedFiles.join("\n")).toContain(
			"/repo/Logger.ts",
		);
	});
	it("records failed and pending edits without claiming that they were saved", () => {
		const messages = [
			call("failed", "file-editor__editor", {
				path: "/repo/failed.ts",
				new_text: "not saved",
			}),
			result("failed", { success: false, error: "stale match" }),
			call("pending", "file-editor__editor", { path: "/repo/pending.ts" }),
		];
		const summary = summarizeToolActivity(messages);
		expect(summary.editedFiles).toEqual([]);
		expect(summary.changes).toEqual([]);
		expect(summary.outcomes?.join("\n")).toContain("stale match");
		expect(summary.outcomes?.join("\n")).toContain("result not present");
		expect(extractFileOps(messages).modifiedFiles).toEqual([]);
	});
	it("serializes structured results and retains terminal failures in bounded logs", () => {
		const serialized = serializeConversation([
			result("check", [
				{
					query: "bun run check-types",
					result: "CHECK_TYPES_EXIT=0",
					success: true,
				},
			]),
			result(
				"log",
				"BUILD_STARTED\n" +
					"routine log\n".repeat(400) +
					"src/common.ts:37 error TS2345\nCHECK_TYPES_EXIT=2",
			),
		]);
		expect(serialized).toContain("CHECK_TYPES_EXIT=0");
		expect(serialized).toContain("BUILD_STARTED");
		expect(serialized).toContain("src/common.ts:37 error TS2345");
		expect(serialized).toContain("CHECK_TYPES_EXIT=2");
		expect(serialized.length).toBeLessThan(2500);
	});
	it("summarizes completed work inside a follow-up task while preserving its request", async () => {
		const request = user(
			"active",
			"  Keep this exact request and finish the verified LogSink fix.\n",
		);
		const messages = [
			user("old", "Earlier setup."),
			request,
			call("check", "run_commands", { commands: ["bun run check-types"] }),
			result("check", [
				{ query: "check types", result: "CHECK_TYPES_EXIT=0", success: true },
			]),
			{
				id: "tail",
				role: "assistant" as const,
				content: "Next: commit the fix.",
			},
		];
		const compacted = await runAgenticCompaction({
			context: context(messages),
			providerConfig,
			preserveRecentTokens: 1,
			estimateMessageTokens: createTokenEstimator(),
		});
		expect(findCutIndex(messages, 1, createTokenEstimator())).toBeGreaterThan(
			1,
		);
		expect(mocks.generate.mock.calls[0][1][0].content).toContain(
			"CHECK_TYPES_EXIT=0",
		);
		expect(
			compacted?.messages.some(
				(m) => JSON.stringify(m.content) === JSON.stringify(request.content),
			),
		).toBe(true);
		expect(text(compacted?.messages)).toContain("Next: commit the fix.");
	});
	it("keeps unresolved calls and matching tool results on the same side of the cut", () => {
		const messages = [
			user("task", "Inspect files."),
			call("a", "read_files", {}),
			call("b", "read_files", {}),
			result("a", "first result"),
			result("b", "second result"),
			{ role: "assistant" as const, content: "tail" },
		];
		const cut = findCutIndex(messages, 1, createTokenEstimator());
		for (const id of ["a", "b"]) {
			const owner = messages.findIndex(
				(m) =>
					Array.isArray(m.content) &&
					m.content.some((p) => p.type === "tool_use" && p.id === id),
			);
			const output = messages.findIndex(
				(m) =>
					Array.isArray(m.content) &&
					m.content.some(
						(p) => p.type === "tool_result" && p.tool_use_id === id,
					),
			);
			expect(owner < cut).toBe(output < cut);
		}
		expect(
			findCutIndex(messages.slice(0, 4), 1, createTokenEstimator()),
		).toBeLessThanOrEqual(1);
	});
	it.each([
		34000, 50000, 62000, 63000,
	])("moves the configured target while retaining the original trigger at %i candidate tokens", async (candidateTokens) => {
		const messages = [
			user("task", "Finish the PR and keep the verified LogSink edit."),
			{ role: "assistant" as const, content: "old work ".repeat(5000) },
			{ role: "assistant" as const, content: "tail" },
		];
		const info = {
			...providerConfig.knownModels.local,
			maxInputTokens: 92160,
			contextWindow: 100352,
		};
		const measured = (inputTokens: number): RequestInputTokenCount => ({
			inputTokens,
			source: "tokenized",
			fingerprint: "moving",
			budgetRevision: "moving",
			maxInputTokens: 92159,
			maxOutputTokens: 8192,
			contextWindow: 100352,
			compactionBufferTokens: 2048,
			serverBoundaryTokens: 1,
		});
		const prepare = createContextCompactionPrepareTurn({
			...providerConfig,
			providerConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1,
				targetTokens: 35000,
				maxTargetTokens: 62000,
			},
		})!;
		const notices = vi.fn();
		const pending = prepare({
			agentId: "test",
			conversationId: "moving",
			parentAgentId: null,
			iteration: 1,
			messages,
			apiMessages: messages,
			systemPrompt: "System",
			tools: [],
			model: { id: "local", provider: "openai-compatible", info },
			abortSignal: new AbortController().signal,
			countRequestInputTokens: async (candidate) =>
				measured(
					candidate === messages
						? 91700
						: candidate.some((m) => m.metadata?.kind === "compaction_summary")
							? candidateTokens
							: 34000,
				),
			emitStatusNotice: notices,
		});
		if (candidateTokens > 62000) {
			await expect(pending).rejects.toThrow(/original context was preserved/i);
			expect(
				notices.mock.calls.some(([, meta]) => meta.phase === "completed"),
			).toBe(false);
			return;
		}
		const output = await pending;
		const completed = notices.mock.calls.find(
			([, meta]) => meta.phase === "completed",
		)?.[1];
		expect(completed).toMatchObject({
			preferredTargetTokens: 35000,
			maxTargetTokens: 62000,
			tokensAfter: candidateTokens <= 62000 ? candidateTokens : 34000,
		});
		expect(
			notices.mock.calls.find(([, meta]) => meta.phase === "started")?.[1],
		).toMatchObject({ triggerTokens: 90111, targetTokens: 35000 });
		expect(text(output?.messages)).toContain(
			"Finish the PR and keep the verified LogSink edit.",
		);
		if (candidateTokens <= 62000)
			expect(text(output?.messages)).toContain("LogSink is fixed and verified");
	});
	it("does not interpret the maximum target as a new trigger", async () => {
		const messages = [user("task", "Keep working at 65K.")];
		const compact = vi.fn();
		const prepare = createContextCompactionPrepareTurn({
			...providerConfig,
			compaction: {
				enabled: true,
				compact,
				targetTokens: 35000,
				maxTargetTokens: 62000,
			},
		})!;
		expect(
			await prepare({
				agentId: "test",
				conversationId: "moving",
				parentAgentId: null,
				iteration: 1,
				messages,
				apiMessages: messages,
				systemPrompt: "System",
				tools: [],
				model: {
					id: "local",
					provider: "openai-compatible",
					info: providerConfig.knownModels.local,
				},
				abortSignal: new AbortController().signal,
				countRequestInputTokens: async () => ({
					inputTokens: 65000,
					source: "tokenized",
					fingerprint: "not-triggered",
					budgetRevision: "test",
					maxInputTokens: 92159,
					maxOutputTokens: 8192,
					contextWindow: 100352,
					compactionBufferTokens: 2048,
					serverBoundaryTokens: 1,
				}),
			}),
		).toBeUndefined();
		expect(compact).not.toHaveBeenCalled();
	});
	it("accepts a useful semantic checkpoint above the preferred target with measured growth room", async () => {
		const messages = [
			user("task", "Finish the PR."),
			{ role: "assistant" as const, content: "old work ".repeat(5000) },
			{ role: "assistant" as const, content: "tail" },
		];
		const measured = (inputTokens: number): RequestInputTokenCount => ({
			inputTokens,
			source: "tokenized",
			fingerprint: "fixture",
			budgetRevision: "fixture",
			maxInputTokens: 73727,
			maxOutputTokens: 8192,
			contextWindow: 81920,
			compactionBufferTokens: 2048,
			serverBoundaryTokens: 1,
		});
		const prepare = createContextCompactionPrepareTurn({
			...providerConfig,
			providerConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1,
			},
		})!;
		const notices = vi.fn();
		const output = await prepare({
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
				provider: "openai-compatible",
				info: providerConfig.knownModels.local,
			},
			abortSignal: new AbortController().signal,
			countRequestInputTokens: async (candidate) =>
				measured(candidate === messages ? 72000 : 50000),
			emitStatusNotice: notices,
		});
		expect(text(output?.messages)).toContain("LogSink is fixed and verified");
		expect(mocks.generate).toHaveBeenCalledTimes(1);
		expect(
			notices.mock.calls.find(([, meta]) => meta.phase === "completed")?.[1],
		).toMatchObject({ tokensAfter: 50000 });
	});
});

it("fails closed for a bad measured summary instead of committing a basic fallback", async () => {
	mocks.generate.mockImplementation(async function* () {
		yield {
			type: "text",
			text: "Now I will inspect the files and continue your task.",
		};
		yield { type: "done", success: true };
	});
	mocks.count.mockResolvedValue({ inputTokens: 1000, maxInputTokens: 73727 });
	const messages: MessageWithMetadata[] = [
		user("original", "Preserve all verified changes."),
		{
			role: "assistant",
			content: "Verified change and exact result. ".repeat(6000),
		},
		user("latest", "Continue the review."),
	];
	const before = JSON.stringify(messages);
	const notices = vi.fn();
	const prepare = createContextCompactionPrepareTurn({
		providerId: "vllm",
		modelId: "local",
		providerConfig: {
			...providerConfig,
			providerId: "vllm",
			localInference: { contextWindow: 81920, maxOutputTokens: 8192 },
		},
		compaction: { enabled: true, strategy: "agentic" },
	})!;
	await expect(
		prepare({
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
				provider: "vllm",
				info: providerConfig.knownModels.local,
			},
			abortSignal: new AbortController().signal,
			countRequestInputTokens: async () => ({
				inputTokens: 73500,
				source: "tokenized",
				fingerprint: "before",
				budgetRevision: "profile",
				contextWindow: 81920,
				maxInputTokens: 73727,
				maxOutputTokens: 8192,
				compactionBufferTokens: 2048,
				serverBoundaryTokens: 1,
			}),
			emitStatusNotice: notices,
		}),
	).rejects.toThrow("original context was preserved");
	expect(JSON.stringify(messages)).toBe(before);
	expect(
		notices.mock.calls.some(([, meta]) => meta?.phase === "completed"),
	).toBe(false);
});
