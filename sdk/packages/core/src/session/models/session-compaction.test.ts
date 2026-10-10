import { describe, expect, it } from "vitest";
import {
	createSessionCompactionState,
	deriveSessionCompactionState,
	parseSessionCompactionState,
	projectSessionCompactionState,
} from "./session-compaction";

describe("session compaction state", () => {
	it("rejects fallback boundary keys when a message role contains the delimiter", () => {
		expect(() =>
			createSessionCompactionState({
				sourceMessages: [
					{
						role: "user:custom",
						content: "invalid role",
					} as never,
				],
				compactedMessages: [
					{ id: "summary", role: "user" as const, content: "summary" },
				],
				updatedAt: "2026-01-01T00:00:00.000Z",
			}),
		).toThrow("Message role cannot contain ':'");
	});

	it("projects when transport identity (id/ts) was regenerated on round-trip", () => {
		// Regression: the message codec regenerates id/ts on wire/storage
		// round-trips (a store's just-appended user turn has none yet, and
		// consolidated parallel tool results are re-split with minted ids on
		// resume). The fingerprint must cover content, not the envelope, or
		// persistence is rejected for semantically identical prefixes.
		const toolResult = (toolUseId: string, id: string, ts: number) => ({
			id,
			ts,
			role: "user" as const,
			content: [
				{
					type: "tool_result" as const,
					tool_use_id: toolUseId,
					name: "read_files",
					content: `result ${toolUseId}`,
				},
			],
		});
		const sourceMessages = [
			{ id: "u1", ts: 1, role: "user" as const, content: "read three files" },
			{
				id: "a1",
				ts: 2,
				role: "assistant" as const,
				content: ["a", "b", "c"].map((id) => ({
					type: "tool_use" as const,
					id,
					name: "read_files",
					input: { files: [`${id}.txt`] },
				})),
			},
			toolResult("a", "tool-a", 3),
			toolResult("b", "tool-b", 4),
			toolResult("c", "tool-c", 5),
		];
		const compactedMessages = [
			{ id: "summary", role: "user" as const, content: "summary" },
		];
		const state = createSessionCompactionState({
			sourceMessages,
			compactedMessages,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		// Same content after a resume round-trip: the typed turn lost its
		// id/ts and the split tool results carry freshly minted identity.
		const resumedMessages = [
			{ role: "user" as const, content: "read three files" },
			{ ...sourceMessages[1], id: "a1-regenerated", ts: 20 },
			toolResult("a", "tool-a_tool_a", 30),
			toolResult("b", "tool-a_tool_b", 30),
			toolResult("c", "tool-a_tool_c", 30),
		];

		expect(projectSessionCompactionState(state, resumedMessages)).toEqual(
			compactedMessages,
		);
	});

	it("rejects projection when the canonical prefix was edited before the boundary", () => {
		const sourceMessages = [
			{ id: "u1", role: "user" as const, content: "original detail" },
			{ id: "a1", role: "assistant" as const, content: "answer" },
		];
		const state = createSessionCompactionState({
			sourceMessages,
			compactedMessages: [
				{ id: "summary", role: "user" as const, content: "summary" },
			],
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const editedPrefix = [
			{ ...sourceMessages[0], content: "redacted detail" },
			sourceMessages[1],
			{ id: "u2", role: "user" as const, content: "tail" },
		];

		expect(projectSessionCompactionState(state, editedPrefix)).toBeUndefined();
	});

	it("projects compacted state when the canonical prefix matches exactly", () => {
		const sourceMessages = [
			{ id: "u1", role: "user" as const, content: "original detail" },
			{ id: "a1", role: "assistant" as const, content: "answer" },
		];
		const compactedMessages = [
			{ id: "summary", role: "user" as const, content: "summary" },
		];
		const tail = { id: "u2", role: "user" as const, content: "tail" };
		const state = createSessionCompactionState({
			sourceMessages,
			compactedMessages,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(
			projectSessionCompactionState(state, [...sourceMessages, tail]),
		).toEqual([...compactedMessages, tail]);
	});

	it("projects after persisted source messages are reloaded from JSON", () => {
		const sourceMessages = [
			{
				id: "a1",
				role: "assistant" as const,
				content: "answer",
				metadata: { b: 2, a: 1 },
				metrics: { inputTokens: 10, outputTokens: 5 },
			},
		];
		const compactedMessages = [
			{ id: "summary", role: "user" as const, content: "summary" },
		];
		const state = createSessionCompactionState({
			sourceMessages,
			compactedMessages,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const reloadedMessages = JSON.parse(JSON.stringify(sourceMessages));

		expect(projectSessionCompactionState(state, reloadedMessages)).toEqual(
			compactedMessages,
		);
	});

	it("rejects projection when canonical message metadata changed", () => {
		const sourceMessages = [
			{
				id: "a1",
				role: "assistant" as const,
				content: "answer",
				metadata: { stable: true },
			},
		];
		const state = createSessionCompactionState({
			sourceMessages,
			compactedMessages: [
				{ id: "summary", role: "user" as const, content: "summary" },
			],
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(
			projectSessionCompactionState(state, [
				{ ...sourceMessages[0], metadata: { stable: false } },
			]),
		).toBeUndefined();
	});

	it("projects when resumed user input was display-normalized from persisted history", () => {
		const sourceMessages = [
			{
				id: "u1",
				role: "user" as const,
				content: '<user_input mode="act">hello</user_input>',
			},
			{
				id: "u2",
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: '<user_input mode="act">inspect</user_input>',
					},
				],
			},
			{ id: "a1", role: "assistant" as const, content: "answer" },
		];
		const resumedMessages = [
			{ ...sourceMessages[0], content: "hello" },
			{
				...sourceMessages[1],
				content: [{ type: "text" as const, text: "inspect" }],
			},
			sourceMessages[2],
			{ id: "u3", role: "user" as const, content: "tail" },
		];
		const compactedMessages = [
			{ id: "summary", role: "user" as const, content: "summary" },
		];
		const state = createSessionCompactionState({
			sourceMessages,
			compactedMessages,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(projectSessionCompactionState(state, resumedMessages)).toEqual([
			...compactedMessages,
			resumedMessages[3],
		]);
	});

	it("rejects anchor-free sidecars even when the source count is zero", () => {
		const state = parseSessionCompactionState({
			version: 1,
			updated_at: "2026-01-01T00:00:00.000Z",
			source_message_count: 0,
			messages: [
				{ id: "summary", role: "user" as const, content: "unanchored" },
			],
		});

		expect(state).toBeDefined();
		if (!state) {
			throw new Error("expected parsed compaction state");
		}
		expect(
			projectSessionCompactionState(state, [
				{ id: "u1", role: "user", content: "canonical" },
			]),
		).toBeUndefined();
	});

	it("projects legacy sidecars when the boundary key matches", () => {
		const sourceMessages = [
			{ id: "u1", role: "user" as const, content: "original detail" },
			{ id: "a1", role: "assistant" as const, content: "answer" },
		];
		const tail = { id: "u2", role: "user" as const, content: "tail" };
		const state = parseSessionCompactionState({
			version: 1,
			updated_at: "2026-01-01T00:00:00.000Z",
			source_message_count: sourceMessages.length,
			source_last_message_key: "id:a1",
			messages: [{ id: "summary", role: "user" as const, content: "summary" }],
		});

		expect(state).toBeDefined();
		if (!state) {
			throw new Error("expected parsed compaction state");
		}
		expect(
			projectSessionCompactionState(state, [...sourceMessages, tail]),
		).toEqual([{ id: "summary", role: "user", content: "summary" }, tail]);
	});

	it("rejects malformed sidecar timestamps", () => {
		const state = parseSessionCompactionState({
			version: 1,
			updated_at: "not-a-date",
			source_message_count: 1,
			source_prefix_hash: "sha256:test",
			messages: [{ id: "summary", role: "user" as const, content: "summary" }],
		});

		expect(state).toBeUndefined();
	});
});

describe("display-only history and compaction", () => {
	const conversation = [
		{ id: "u1", role: "user" as const, content: "first" },
		{ id: "u2", role: "user" as const, content: "retry" },
		{ id: "a2", role: "assistant" as const, content: "answer" },
	];
	const error = {
		id: "error",
		role: "assistant" as const,
		content: "provider failed",
		metadata: { displayOnly: true, displayRole: "error" },
	};
	const history = [conversation[0], error, ...conversation.slice(1)];
	const summary = [{ role: "user" as const, content: "summary" }];

	it("uses the same anchors for persisted and runtime history", () => {
		const fromHistory = createSessionCompactionState({
			sourceMessages: history,
			compactedMessages: summary,
		});
		const fromRuntime = createSessionCompactionState({
			sourceMessages: conversation,
			compactedMessages: summary,
		});
		expect(fromHistory.source_message_count).toBe(conversation.length);
		expect(fromHistory.source_prefix_hash).toBe(fromRuntime.source_prefix_hash);
		expect(projectSessionCompactionState(fromHistory, conversation)).toEqual(
			summary,
		);
		expect(projectSessionCompactionState(fromRuntime, history)).toEqual(
			summary,
		);
	});

	it("excludes display-only entries from the boundary and appended tail", () => {
		const state = createSessionCompactionState({
			sourceMessages: [...conversation, error],
			compactedMessages: summary,
		});
		expect(state.source_last_message_key).toBe("id:a2");
		const tail = { role: "user" as const, content: "continue" };
		expect(
			projectSessionCompactionState(state, [...history, error, tail]),
		).toEqual([...summary, tail]);
	});
});

describe("compaction state copy boundaries", () => {
	const source = [
		{ role: "user" as const, content: "first task" },
		{ role: "assistant" as const, content: "first answer" },
		{ role: "user" as const, content: "second task" },
		{ role: "assistant" as const, content: "second answer" },
	];
	const summary = {
		role: "user" as const,
		content: "first task summary",
		metadata: { kind: "compaction_summary" },
	};
	const oldCopy = createSessionCompactionState({
		sourceMessages: source,
		compactedMessages: [summary, ...source.slice(2)],
		conversationId: "old",
	});
	it("recovers an older inflated anchor before Undo and repost", () => {
		const undo = source.slice(0, 2);
		const carried = deriveSessionCompactionState({
			state: oldCopy,
			sourceMessages: source,
			targetMessages: undo,
		});
		expect(carried?.source_message_count).toBe(2);
		expect(carried?.conversation_id).toBeUndefined();
		expect(projectSessionCompactionState(carried!, undo)).toEqual([summary]);
		const repost = [...undo, { ...source[2]!, content: "reposted task" }];
		expect(projectSessionCompactionState(carried!, repost)).toEqual([
			summary,
			repost[2],
		]);
		const copied = deriveSessionCompactionState({
			state: carried!,
			sourceMessages: repost,
		});
		expect(copied?.source_message_count).toBe(2);
		expect(projectSessionCompactionState(copied!, undo)).toEqual([summary]);
	});
	it("keeps copy boundaries independent of later canonical messages", () => {
		const state = createSessionCompactionState({
			sourceMessages: source.slice(0, 2),
			compactedMessages: [summary],
		});
		const copied = deriveSessionCompactionState({
			state,
			sourceMessages: source,
		});
		expect(copied?.source_message_count).toBe(2);
		expect(projectSessionCompactionState(copied!, source)).toEqual([
			summary,
			...source.slice(2),
		]);
	});
	it("rejects an edited original anchor before peeling its tail", () => {
		expect(
			deriveSessionCompactionState({
				state: oldCopy,
				sourceMessages: [
					source[0]!,
					{ ...source[1]!, content: "edited" },
					...source.slice(2),
				],
				targetMessages: source.slice(0, 2),
			}),
		).toBeUndefined();
	});
	it("rejects Undo into history represented only by the summary", () => {
		expect(
			deriveSessionCompactionState({
				state: oldCopy,
				sourceMessages: source,
				targetMessages: source.slice(0, 1),
			}),
		).toBeUndefined();
		const future = createSessionCompactionState({
			sourceMessages: source,
			compactedMessages: [summary],
		});
		expect(
			deriveSessionCompactionState({
				state: future,
				sourceMessages: source,
				targetMessages: source.slice(0, 2),
			}),
		).toBeUndefined();
	});
	it("compares durable content across normalized input and regenerated IDs", () => {
		const old = createSessionCompactionState({
			sourceMessages: source,
			compactedMessages: [
				summary,
				{
					...source[2]!,
					id: "wire",
					content: '<user_input mode="act">second task</user_input>',
				},
				{ ...source[3]!, ts: 123 },
			],
		});
		const carried = deriveSessionCompactionState({
			state: old,
			sourceMessages: source,
			targetMessages: source.slice(0, 2),
			conversationId: "new",
		});
		expect(carried?.conversation_id).toBe("new");
		expect(carried?.source_message_count).toBe(2);
	});
	it("handles display-only history without moving the canonical boundary", () => {
		const history = [
			...source.slice(0, 2),
			{
				role: "assistant" as const,
				content: "error",
				metadata: { displayOnly: true },
			},
			...source.slice(2),
		];
		const carried = deriveSessionCompactionState({
			state: oldCopy,
			sourceMessages: history,
			targetMessages: history.slice(0, 3),
		});
		expect(
			projectSessionCompactionState(carried!, history.slice(0, 3)),
		).toEqual([summary]);
	});
});
