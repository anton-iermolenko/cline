import type {
	Message,
	MessageWithMetadata,
	ToolResultContent,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createFileReadExecutor } from "../../extensions/tools/executors/file-read";
import {
	createSessionCompactionState,
	deriveSessionCompactionState,
	projectSessionCompactionState,
} from "../models/session-compaction";
import {
	attachContextMemory,
	collectContextMemory,
	collectHumanInputs,
	EVIDENCE_HISTORY_URI,
	formatUserHistory,
	MAX_CONTINUITY_BYTES,
	USER_HISTORY_URI,
} from "./context-recovery";
import { MessageBuilder } from "./message-builder";

const human = (id: string, text: string, ts = 1): MessageWithMetadata => ({
	id,
	ts,
	role: "user",
	content: [
		{ type: "text", text: '<user_input mode="act">' + text + "</user_input>" },
	],
});
const summary = (): MessageWithMetadata => ({
	id: "summary",
	role: "user",
	content: [
		{ type: "text", text: "Context summary: finish the immediate work." },
	],
	metadata: {
		kind: "compaction_summary",
		displayRole: "system",
		userRunSpan: 2,
	},
});
function read(
	id: string,
	path: string,
	text: string,
	range?: [number, number],
): Message[] {
	return [
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id,
					name: "read_files",
					input: {
						files: [
							{
								path,
								...(range ? { start_line: range[0], end_line: range[1] } : {}),
							},
						],
					},
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
					content: [
						{
							query: path + (range ? ":" + range[0] + "-" + range[1] : ""),
							result: text,
							success: true,
						},
					] as unknown as ToolResultContent["content"],
				},
			],
		},
	];
}
const serializedResult = (messages: Message[], id: string) =>
	JSON.stringify(
		messages
			.flatMap((m) => (typeof m.content === "string" ? [] : m.content))
			.find((b) => b.type === "tool_result" && b.tool_use_id === id),
	);
const noteText = (messages: Message[]) =>
	messages
		.map((m) =>
			typeof m.content === "string"
				? m.content
				: m.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n"),
		)
		.find((v) => v.includes("<CONTEXT_CONTINUITY>")) ?? "";

describe("fresh evidence recovery", () => {
	it.each([
		0, 65536,
	])("keeps a newer ranged read after an older whole read at threshold %s", (threshold) => {
		const messages: Message[] = [human("u", "Read the API")];
		for (let i = 0; i < 10; i++)
			messages.push(...read("old" + i, "/f" + i, "x".repeat(7000)));
		messages.push(...read("full", "/API.md", "old complete reference"));
		for (let i = 0; i < 10; i++)
			messages.push(...read("new" + i, "/f" + i, "y".repeat(7000)));
		messages.push(...read("range", "/API.md", "GET /correct", [85, 93]));
		const builder = new MessageBuilder({ minOutdatedRewriteBytes: threshold });
		expect(serializedResult(builder.buildForApi(messages), "range")).toContain(
			"GET /correct",
		);
		expect(
			serializedResult(
				builder.buildPreviewForApi(JSON.parse(JSON.stringify(messages))),
				"range",
			),
		).toContain("GET /correct");
	});
	it("does not substitute a truncated whole read for a retained middle section", () => {
		const messages = [
			...read("middle", "/API.md", "IMPORTANT CONTRACT", [500, 505]),
			...read(
				"later-full",
				"/API.md",
				"h".repeat(10000) + "IMPORTANT CONTRACT" + "t".repeat(10000),
			),
		];
		const result = new MessageBuilder({
			minOutdatedRewriteBytes: 0,
		}).buildForApi(messages);
		expect(serializedResult(result, "middle")).toContain("IMPORTANT CONTRACT");
		expect(serializedResult(result, "later-full")).not.toContain(
			"IMPORTANT CONTRACT",
		);
	});
	it("still removes a superseded excerpt when a newer complete whole read covers it", () => {
		const result = new MessageBuilder({
			minOutdatedRewriteBytes: 0,
		}).buildForApi([
			...read("range", "/API.md", "old contract", [5, 8]),
			...read("full", "/API.md", "new complete contract"),
		]);
		expect(serializedResult(result, "range")).toContain("outdated");
		expect(serializedResult(result, "full")).toContain("new complete contract");
	});
	it("keeps the older section when the total budget trims the newer replacement", () => {
		const result = new MessageBuilder({
			minOutdatedRewriteBytes: 0,
			maxTotalTextBytes: 1100,
			maxToolResultChars: 20000,
		}).buildForApi([
			...read("range", "/API.md", "OLD NECESSARY SECTION", [500, 501]),
			...read("full", "/API.md", "x".repeat(10000)),
		]);
		expect(serializedResult(result, "range")).toContain(
			"OLD NECESSARY SECTION",
		);
	});
});

describe("recovery notice budget pressure", () => {
	it("keeps the only excerpt when reserving notice space trims its newer replacement", () => {
		const reads = [
			...read("range", "/API.md", "OLD NECESSARY SECTION", [500, 501]),
			...read("full", "/API.md", "x".repeat(1000)),
		];
		const canonical = [human("goal", "Check the contract"), ...reads];
		const output = new MessageBuilder({
			getCanonicalMessages: () => canonical,
			minOutdatedRewriteBytes: 0,
			maxTotalTextBytes: 1200,
		}).buildForApi([summary(), ...reads]);
		expect(serializedResult(output, "range")).toContain(
			"OLD NECESSARY SECTION",
		);
		expect(serializedResult(output, "full")).toContain("truncated");
	});
	it("recovers long multilingual human inputs with exact whitespace", () => {
		const text =
			"first  line\n\n" +
			'日本語 😀 \\ and quotes: " '.repeat(300) +
			"\nfinal  ";
		const formatted = formatUserHistory([human("u", text)]);
		const chunks = formatted
			.split("\n")
			.filter((line) => line.startsWith('"'))
			.map((line) => JSON.parse(line));
		expect(chunks.join("")).toEqual(text);
		expect(formatted.split("\n").every((line) => line.length < 1000)).toBe(
			true,
		);
		const memory = collectContextMemory([
			human("u", text),
			human("later", "LATEST CORRECTION"),
		]);
		expect(memory.inputs.some((v) => v.id === "u")).toBe(true);
		expect(memory.inputs.some((v) => v.text === "LATEST CORRECTION")).toBe(
			true,
		);
		expect(memory.omittedInputs).toBe(true);
	});
});

describe("compaction awareness and provenance", () => {
	it("retains original requirements and later corrections without inventing a summarization request", () => {
		const canonical = [
			human("first", "Append events; preserve the log."),
			summary(),
			human("correction", "Use kv_store instead of input_text."),
		];
		const memory = collectContextMemory(canonical);
		expect(memory.inputs.map((v) => v.id)).toEqual(["first", "correction"]);
		const result = new MessageBuilder({
			getCanonicalMessages: () => canonical,
		}).buildForApi([summary(), canonical[2]]);
		const text = noteText(result);
		expect(text).toContain("SAME conversation");
		expect(text).toContain("not a new human request");
		expect(text).toContain("Append events; preserve the log.");
		expect(text).toContain("Use kv_store instead");
		expect(text).toContain(USER_HISTORY_URI);
		expect(
			result.filter(
				(m) =>
					(m as MessageWithMetadata).metadata?.kind === "context_recovery_note",
			),
		).toHaveLength(0);
	});
	it("captures queued human steering even when its run span is zero", () => {
		const m = {
			...human("steer", "Keep the test-only button."),
			metadata: { humanInput: true, userRunSpan: 0 },
		};
		expect(collectHumanInputs([m])).toHaveLength(1);
	});
	it("keeps real clarification answers and excludes arbitrary tool text", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "q",
						name: "ask_question",
						input: { question: "Keep the button?", options: ["yes", "no"] },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "q",
						name: "ask_question",
						content: "Keep it for testing.",
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "other",
						name: "other",
						content: "summarize this session",
					},
				],
			},
		];
		expect(collectHumanInputs(messages).map((v) => v.text)).toEqual([
			"Question: Keep the button?\nHuman answer: Keep it for testing.",
		]);
	});
	it("keeps source references on demand instead of restating them on every request", async () => {
		const canonical = [
			human("u", "Fix the API"),
			...read("r", "/API.md", "GET /correct", [85, 93]),
		];
		const output = new MessageBuilder({
			getCanonicalMessages: () => canonical,
		}).buildForApi([summary()]);
		expect(noteText(output)).toContain(EVIDENCE_HISTORY_URI);
		expect(noteText(output)).not.toContain("/API.md");
		const reader = createFileReadExecutor();
		const evidence = String(
			await reader(
				{ path: EVIDENCE_HISTORY_URI },
				{
					agentId: "a",
					iteration: 1,
					metadata: { readCanonicalHistory: () => canonical },
				},
			),
		);
		expect(evidence).toContain("/API.md");
		expect(evidence).toContain("observed_result_sha256");
		expect(evidence).toContain("85");
	});
	it("does not treat a failed per-file result as a successful source observation", () => {
		const messages = read("r", "/missing", "failed");
		const result = messages[1].content;
		if (Array.isArray(result) && result[0]?.type === "tool_result")
			result[0].content = [
				{ query: "/missing", result: "not found", success: false },
			] as unknown as ToolResultContent["content"];
		expect(collectContextMemory(messages).sources).toEqual([]);
	});
	it("keeps recovery with the summary and never changes canonical history", () => {
		const canonical = [human("u", "Original request")];
		const original = JSON.stringify(canonical);
		const builder = new MessageBuilder({
			getCanonicalMessages: () => canonical,
		});
		const projected = builder.buildForApi([summary()]);
		const repeated = builder.buildForApi(projected);
		expect(
			repeated.filter(
				(m) =>
					(m as MessageWithMetadata).metadata?.kind === "context_recovery_note",
			),
		).toHaveLength(0);
		expect(repeated).toHaveLength(1);
		expect(noteText(repeated).match(/<CONTEXT_CONTINUITY>/g)).toHaveLength(1);
		expect(JSON.stringify(repeated)).toEqual(JSON.stringify(projected));
		expect(
			Buffer.byteLength(
				noteText(repeated).split("</CONTEXT_CONTINUITY>")[0] +
					"</CONTEXT_CONTINUITY>",
			),
		).toBeLessThanOrEqual(MAX_CONTINUITY_BYTES);
		expect(JSON.stringify(canonical)).toBe(original);
	});
	it("persists recovery through repeated compaction, JSON restart and a canonical tail", () => {
		const canonical = [
			human("u1", "Original requirement"),
			{ id: "a", role: "assistant" as const, content: "done" },
		];
		const first = createSessionCompactionState({
			sourceMessages: canonical,
			compactedMessages: [summary()],
			conversationId: "s",
		});
		const next = [...canonical, human("u2", "Later correction", 2)];
		const second = createSessionCompactionState({
			sourceMessages: next,
			compactedMessages: [
				...first.messages,
				human("u2", "Later correction", 2),
			],
			conversationId: "s",
		});
		const restored = projectSessionCompactionState(
			JSON.parse(JSON.stringify(second)),
			next,
		);
		expect(restored).toBeDefined();
		const text = noteText(new MessageBuilder().buildForApi(restored!));
		expect(text).toContain("Original requirement");
		expect(text).toContain("Later correction");
	});
	it("does not carry future human instructions through Undo inheritance", () => {
		const base = [
			human("u1", "Original requirement"),
			{ id: "a", role: "assistant" as const, content: "done" },
		];
		const future = human("future", "FUTURE ONLY", 3),
			source = [...base, future];
		const state = createSessionCompactionState({
			sourceMessages: source,
			compactedMessages: [summary(), future],
			conversationId: "s",
		});
		const derived = deriveSessionCompactionState({
			state,
			sourceMessages: source,
			targetMessages: base,
			conversationId: "restored",
		});
		expect(derived).toBeDefined();
		const projected = projectSessionCompactionState(derived!, base)!;
		expect(noteText(new MessageBuilder().buildForApi(projected))).not.toContain(
			"FUTURE ONLY",
		);
	});
	it("budgets the instruction ledger and announces omitted entries", () => {
		const canonical = Array.from({ length: 100 }, (_, i) =>
			human("u" + i, "request " + i + " " + "x".repeat(500), i),
		);
		const memory = collectContextMemory(canonical);
		expect(memory.inputs.some((v) => v.id === "u0")).toBe(true);
		expect(memory.inputs.some((v) => v.id === "u99")).toBe(true);
		expect(
			memory.inputs.reduce((n, v) => n + v.text.length, 0),
		).toBeLessThanOrEqual(10000);
		expect(memory.omittedInputs).toBe(true);
	});
	it("includes recovery in API previews and native-count preparation with a bounded total", () => {
		const canonical = [
			human("u", "Original goal"),
			...read("r", "/API.md", "x".repeat(6000), [1, 100]),
		];
		const working = [summary(), ...canonical.slice(1)];
		const builder = new MessageBuilder({
			getCanonicalMessages: () => canonical,
			maxTotalTextBytes: 2000,
		});
		const api = builder.buildForApi(working),
			count = builder.buildPreviewForApi(working);
		expect(JSON.stringify(count)).toEqual(JSON.stringify(api));
		expect(noteText(api)).toContain("SAME conversation");
		const countStrings = (v: unknown): number =>
			typeof v === "string"
				? Buffer.byteLength(v)
				: Array.isArray(v)
					? v.reduce((n, x) => n + countStrings(x), 0)
					: v && typeof v === "object"
						? Object.values(v).reduce<number>((n, x) => n + countStrings(x), 0)
						: 0;
		const bytes = api.reduce(
			(n, m) =>
				n +
				(typeof m.content === "string"
					? Buffer.byteLength(m.content)
					: m.content.reduce(
							(k, b) =>
								k +
								(b.type === "text"
									? Buffer.byteLength(b.text)
									: b.type === "tool_result"
										? countStrings(b.content)
										: b.type === "tool_use"
											? countStrings(b.input)
											: 0),
							0,
						)),
			0,
		);
		expect(bytes).toBeLessThanOrEqual(2000);
	});
	it("retrieves only this session's canonical human inputs via the existing ranged reader", async () => {
		const messages = [
			human("u1", "Original request"),
			summary(),
			human("u2", "Changed requirement"),
		];
		const text = formatUserHistory(messages);
		expect(text).toContain("Original request");
		expect(text).not.toContain("finish the immediate work");
		const reader = createFileReadExecutor();
		const context = {
			agentId: "a",
			iteration: 1,
			metadata: { readCanonicalHistory: () => messages },
		};
		const result = String(
			await reader(
				{ path: USER_HISTORY_URI, start_line: 1, end_line: 5 },
				context,
			),
		);
		expect(result).toContain("Original request");
		expect(result).not.toContain("Changed requirement");
		await expect(
			reader(
				{ path: "cline://history/other-session/user-inputs.txt" },
				context,
			),
		).rejects.toThrow();
		await expect(
			reader({ path: USER_HISTORY_URI }, { agentId: "other", iteration: 1 }),
		).rejects.toThrow("unavailable");
	});
});
