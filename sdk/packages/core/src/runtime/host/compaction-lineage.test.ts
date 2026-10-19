import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSessionCompactionState,
	projectSessionCompactionState,
} from "../../session/models/session-compaction";
import { FileSessionService } from "../../session/services/file-session-service";
import { SessionSource } from "../../types/common";
import { LocalRuntimeHost } from "./local-runtime-host";
import { splitCoreSessionConfig } from "./runtime-host";

const messages = [
	{ role: "user" as const, content: "first" },
	{ role: "assistant" as const, content: "answer" },
	{ role: "user" as const, content: "next" },
];
const summary = {
	role: "user" as const,
	content: "summary",
	metadata: { kind: "compaction_summary" },
};
const recoveredSummary = {
	...summary,
	metadata: {
		...summary.metadata,
		contextMemory: {
			version: 1,
			totalInputs: 1,
			inputs: [expect.objectContaining({ text: "first", kind: "request" })],
			omittedInputs: false,
			sources: [],
		},
	},
};
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "cline-lineage-"));
	dirs.push(dir);
	const store = new FileSessionService(dir);
	async function create(
		id: string,
		metadata: Record<string, unknown> = {},
		history = messages,
	) {
		const artifacts = await store.createRootSessionWithArtifacts({
			sessionId: id,
			source: SessionSource.CLI,
			pid: process.pid,
			interactive: true,
			provider: "openai-compatible",
			model: "test",
			cwd: "/tmp",
			workspaceRoot: "/tmp",
			enableTools: false,
			enableSpawn: false,
			enableTeams: false,
			metadata,
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		await store.persistSessionMessages(id, history);
		return artifacts;
	}
	await create("ancestor");
	const state = createSessionCompactionState({
		sourceMessages: messages.slice(0, 2),
		compactedMessages: [summary],
		conversationId: "ancestor",
	});
	await store.persistSessionCompactionState("ancestor", state);
	const host = new LocalRuntimeHost({ sessionService: store });
	return { dir, store, host, create, state };
}
describe("missing compaction sidecar lineage recovery", () => {
	it("recovers through multiple damaged Undo descendants without rewriting history", async () => {
		const { host, create } = await fixture();
		await create("missing", { restoredFromSessionId: "ancestor" });
		const child = await create(
			"child",
			{ restoredFromSessionId: "missing" },
			messages.slice(0, 2),
		);
		const before = readFileSync(child.messagesPath);
		const recovered = await host.readSessionCompactionState("child");
		expect(recovered?.conversation_id).toBe("child");
		expect(
			projectSessionCompactionState(recovered!, messages.slice(0, 2)),
		).toEqual([recoveredSummary]);
		expect(readFileSync(child.messagesPath)).toEqual(before);
		expect(existsSync(child.compactionPath!)).toBe(false);
	});

	it("loads ancestor context on resume before preparing the next request", async () => {
		const { store, create } = await fixture();
		await create("missing", { restoredFromSessionId: "ancestor" });
		await create("child", { restoredFromSessionId: "missing" });
		const makeAgent = vi.fn().mockReturnValue({
			run: vi.fn(),
			continue: vi.fn(),
			abort: vi.fn(),
			subscribeEvents: () => () => {},
			canStartRun: () => true,
			getAgentId: () => "test-agent",
			getConversationId: () => "child",
			getMessages: () => messages,
			restore: vi.fn(),
			shutdown: async () => {},
			messages,
		});
		const host = new LocalRuntimeHost({
			sessionService: store,
			runtimeBuilder: {
				build: () => ({ tools: [], shutdown: async () => {} }),
			} as never,
			createAgent: makeAgent as never,
		});
		try {
			await host.startSession({
				...splitCoreSessionConfig({
					systemPrompt: "saved instructions",
					providerId: "openai-compatible",
					modelId: "test",
					apiKey: "placeholder",
					baseUrl: "http://127.0.0.1:1/v1",
					sessionId: "child",
					cwd: "/tmp",
					workspaceRoot: "/tmp",
					enableTools: false,
					enableSpawnAgent: false,
					enableAgentTeams: false,
					disableMcpSettingsTools: true,
					compaction: { enabled: false },
				}),
				interactive: true,
				initialMessages: messages,
			});
			const prepare = makeAgent.mock.calls[0]?.[0]?.prepareTurn;
			expect(prepare).toBeTypeOf("function");
			const prepared = await prepare({
				messages,
				apiMessages: messages,
				conversationId: "child",
			});
			expect(prepared.messages).toEqual([recoveredSummary, messages[2]]);
		} finally {
			await host.dispose();
		}
	});
	it("follows immediate fork lineage before inherited restore metadata", async () => {
		const { host, create } = await fixture();
		await create("child", {
			restoredFromSessionId: "unrelated",
			fork: { forkedFromSessionId: "ancestor" },
		});
		const state = await host.readSessionCompactionState("child");
		expect(projectSessionCompactionState(state!, messages)).toEqual([
			recoveredSummary,
			messages[2],
		]);
	});

	it("checks the other recorded ancestor when a fork parent is unavailable", async () => {
		const { host, create } = await fixture();
		await create("child", {
			fork: { forkedFromSessionId: "missing-fork" },
			restoredFromSessionId: "ancestor",
		});
		expect(await host.readSessionCompactionState("child")).toBeDefined();
	});
	it("does not recover a summary beyond the target or over an edited prefix", async () => {
		const { host, create } = await fixture();
		await create(
			"early",
			{ restoredFromSessionId: "ancestor" },
			messages.slice(0, 1),
		);
		await create("edited", { restoredFromSessionId: "ancestor" }, [
			{ ...messages[0]!, content: "changed" },
			messages[1]!,
		]);
		expect(await host.readSessionCompactionState("early")).toBeUndefined();
		expect(await host.readSessionCompactionState("edited")).toBeUndefined();
	});
	it("keeps the session's own sidecar authoritative", async () => {
		const { host, store, create } = await fixture();
		await create("child", { restoredFromSessionId: "ancestor" });
		const own = createSessionCompactionState({
			sourceMessages: messages,
			compactedMessages: [{ ...summary, content: "own summary" }],
			conversationId: "child",
		});
		await store.persistSessionCompactionState("child", own);
		expect(await host.readSessionCompactionState("child")).toEqual(own);
	});
	it("terminates cycles and missing ancestors", async () => {
		const { host, create } = await fixture();
		await create("a", { restoredFromSessionId: "b" });
		await create("b", { restoredFromSessionId: "a" });
		await create("orphan", { restoredFromSessionId: "absent" });
		expect(await host.readSessionCompactionState("a")).toBeUndefined();
		expect(await host.readSessionCompactionState("orphan")).toBeUndefined();
	});

	it("bounds lineage traversal and rejects an invalid ancestor anchor", async () => {
		const { host, store, create } = await fixture();
		await store.persistSessionMessages("ancestor", [
			{ ...messages[0]!, content: "edited ancestor" },
			...messages.slice(1),
		]);
		await create("child", { restoredFromSessionId: "ancestor" });
		expect(await host.readSessionCompactionState("child")).toBeUndefined();
		await store.persistSessionMessages("ancestor", messages);
		for (let i = 0; i < 33; i++)
			await create(`deep-${i}`, {
				restoredFromSessionId: i === 32 ? "ancestor" : `deep-${i + 1}`,
			});
		expect(await host.readSessionCompactionState("deep-0")).toBeUndefined();
		expect(await host.readSessionCompactionState("deep-1")).toBeDefined();
	});
	it("rejects a sidecar owned by another conversation", async () => {
		const { host, store, create, state } = await fixture();
		await store.persistSessionCompactionState("ancestor", {
			...state,
			conversation_id: "foreign",
		});
		await create("child", { restoredFromSessionId: "ancestor" });
		expect(await host.readSessionCompactionState("child")).toBeUndefined();
	});
});
