import type { MessageWithMetadata } from "@cline/llms";
import type { HubCommandEnvelope } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import type { HubTransportContext } from "../hub/server/handlers/context";
import { handleSessionRestore } from "../hub/server/handlers/session-handlers";
import { LocalRuntimeHost } from "../runtime/host/local-runtime-host";
import type { StartSessionInput } from "../runtime/host/runtime-host";
import { SessionSource } from "../types/common";
import type { SessionRecord } from "../types/sessions";
import {
	createSessionCompactionState,
	projectSessionCompactionState,
	type SessionCompactionState,
} from "./models/session-compaction";

vi.mock("../hooks/checkpoint-hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../hooks/checkpoint-hooks")>()),
	retainCheckpointRefs: vi.fn(async () => {}),
}));

const messages: MessageWithMetadata[] = [
	{ role: "user", content: "first" },
	{ role: "assistant", content: "first result" },
	{ role: "user", content: "second" },
	{ role: "assistant", content: "second result" },
];
const source: SessionRecord = {
	sessionId: "source",
	updatedAt: "2026-01-01T00:00:00Z",
	isSubagent: false,
	source: SessionSource.CLI,
	pid: 123,
	startedAt: "2026-01-01T00:00:00Z",
	status: "completed",
	interactive: true,
	provider: "openai-compatible",
	model: "local-test",
	cwd: "/test",
	workspaceRoot: "/test",
	enableTools: false,
	enableSpawn: false,
	enableTeams: false,
	prompt: "first",
	messagesPath: "/test/messages.json",
	metadata: {
		checkpoint: {
			history: [
				{ ref: "first-ref", runCount: 1, createdAt: 1, kind: "commit" },
				{ ref: "second-ref", runCount: 2, createdAt: 2, kind: "commit" },
			],
		},
	},
};
const summary: MessageWithMetadata = {
	role: "user",
	content: "Summary of first run",
	metadata: { kind: "compaction_summary" },
};

async function restore(
	path: "hub" | "local",
	state: SessionCompactionState,
	explicit?: SessionCompactionState,
) {
	let started: StartSessionInput | undefined;
	const sessionHost = {
		getSession: vi.fn(async (id: string) =>
			id === "source" ? source : { ...source, sessionId: "replacement" },
		),
		readSessionMessages: vi.fn(async () => messages),
		readSessionCompactionState: vi.fn(async () => state),
		startSession: vi.fn(async (input: StartSessionInput) => {
			started = input;
			return { sessionId: "replacement" };
		}),
	};
	if (path === "hub") {
		const context = {
			sessionHost,
			sessionState: new Map(),
			publish: vi.fn(),
			buildEvent: vi.fn(() => ({})),
		} as unknown as HubTransportContext;
		const envelope = {
			version: "v1",
			requestId: "test-restore",
			clientId: "test-client",
			command: "session.restore",
			payload: {
				sessionId: "source",
				checkpointRunCount: 2,
				sessionConfig: {
					providerId: "openai-compatible",
					modelId: "local-test",
					apiKey: "placeholder",
					cwd: "/test",
					enableTools: false,
				},
				restore: {
					messages: true,
					workspace: false,
					omitCheckpointMessageFromSession: true,
				},
				...(explicit ? { initialCompactionState: explicit } : {}),
			},
		} as unknown as HubCommandEnvelope;
		const reply = await handleSessionRestore(context, envelope, async () => ({
			approved: true,
		}));
		expect(reply.ok).toBe(true);
	} else {
		const host = new LocalRuntimeHost({
			distinctId: "restore-regression",
			sessionService: {} as never,
		});
		vi.spyOn(host, "getSession").mockImplementation(sessionHost.getSession);
		vi.spyOn(host, "readSessionMessages").mockImplementation(
			sessionHost.readSessionMessages,
		);
		vi.spyOn(host, "readSessionCompactionState").mockImplementation(
			sessionHost.readSessionCompactionState,
		);
		vi.spyOn(host, "startSession").mockImplementation(
			sessionHost.startSession as never,
		);
		await host.restoreSession({
			sessionId: "source",
			checkpointRunCount: 2,
			restore: {
				messages: true,
				workspace: false,
				omitCheckpointMessageFromSession: true,
			},
			start: {
				config: {
					providerId: "openai-compatible",
					modelId: "local-test",
					apiKey: "placeholder",
					cwd: "/test",
				},
				...(explicit ? { initialCompactionState: explicit } : {}),
			},
		} as never);
	}
	expect(sessionHost.readSessionCompactionState).toHaveBeenCalledWith("source");
	expect(started?.initialMessages).toEqual(messages.slice(0, 2));
	return started?.initialCompactionState;
}

describe.each([
	"hub",
	"local",
] as const)("%s checkpoint restore with compacted history", (path) => {
	it("starts from the inherited summary without discarding canonical history", async () => {
		const sourceState = createSessionCompactionState({
			sourceMessages: messages.slice(0, 2),
			compactedMessages: [summary],
			conversationId: "source",
		});
		const carried = await restore(path, sourceState);
		expect(carried).toBeDefined();
		expect(
			projectSessionCompactionState(carried!, messages.slice(0, 2)),
		).toEqual([summary]);
		expect(carried?.conversation_id).toBeUndefined();
	});

	it("inherits a copied summary when Undo removes unchanged retained messages", async () => {
		const oldCopy = createSessionCompactionState({
			sourceMessages: messages,
			compactedMessages: [summary, ...messages.slice(2)],
		});
		const carried = await restore(path, oldCopy);
		expect(carried?.source_message_count).toBe(2);
		expect(
			projectSessionCompactionState(carried!, messages.slice(0, 2)),
		).toEqual([summary]);
	});
	it("keeps an explicit initial state authoritative", async () => {
		const sourceState = createSessionCompactionState({
			sourceMessages: messages.slice(0, 2),
			compactedMessages: [summary],
		});
		const explicit = createSessionCompactionState({
			sourceMessages: messages.slice(0, 2),
			compactedMessages: [
				{ ...summary, content: "Explicit compacted context" },
			],
		});
		expect(await restore(path, sourceState, explicit)).toEqual(explicit);
	});
	it("does not inherit a summary covering messages after the restored boundary", async () => {
		const future = createSessionCompactionState({
			sourceMessages: messages,
			compactedMessages: [{ ...summary, content: "Includes second run" }],
		});
		expect(await restore(path, future)).toBeUndefined();
	});
});
