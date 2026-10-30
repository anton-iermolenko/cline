import { fileURLToPath } from "node:url"
import { createSessionCompactionState, projectSessionCompactionState } from "@cline/core"
import type { AgentMessage, MessageWithMetadata } from "@cline/shared"
import { describe, expect, it, vi } from "vitest"
import { sanitizeInitialMessagesForSessionStart } from "./initial-message-sanitizer"

// Exercise Core's real internal codec without including SDK source in the
// extension's TypeScript root or adding a production export solely for tests.
const { agentMessagesToMessagesWithMetadata, messagesToAgentMessages } = await vi.importActual<{
	agentMessagesToMessagesWithMetadata: (messages: readonly AgentMessage[]) => MessageWithMetadata[]
	messagesToAgentMessages: (messages: readonly MessageWithMetadata[]) => AgentMessage[]
}>(fileURLToPath(new URL("../../../../sdk/packages/core/src/runtime/config/agent-message-codec.ts", import.meta.url)))

describe("sanitizeInitialMessagesForSessionStart", () => {
	it("preserves checkpoint projection through resume with parallel results, hook context and human follow-ups", () => {
		const input: MessageWithMetadata[] = [
			{
				id: "calls",
				role: "assistant",
				content: [
					{ type: "tool_use", id: "a", name: "read_files", input: {} },
					{ type: "tool_use", id: "b", name: "read_files", input: {} },
				],
			},
			{
				id: "result-a",
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "a", name: "read_files", content: "A" }],
			},
			{
				id: "result-b",
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "b", name: "read_files", content: "B" }],
			},
			{
				id: "hook",
				role: "user",
				ts: 10,
				metadata: { userRunSpan: 0, displayRole: "system" },
				content: [{ type: "text", text: '<hook_context source="ToolSuccess">Continue.</hook_context>' }],
			},
			{
				id: "human",
				role: "user",
				ts: 20,
				metadata: { kind: "human_input", humanInput: true, userRunSpan: 1 },
				content: [{ type: "text", text: "Check this next." }],
			},
		]
		const original = structuredClone(input)
		const summary: MessageWithMetadata[] = [{ role: "user", content: "Saved notes." }]
		const checkpoint = createSessionCompactionState({ sourceMessages: input, compactedMessages: summary })
		const imageFollowup: MessageWithMetadata = {
			id: "image-followup",
			role: "user",
			content: [
				{ type: "text", text: "What about this?" },
				{ type: "image", mediaType: "image/png", data: "fixture" },
			],
		}
		const cleaned = sanitizeInitialMessagesForSessionStart([...input, imageFollowup])
		const resumed = agentMessagesToMessagesWithMetadata(messagesToAgentMessages(cleaned))
		expect(cleaned).toContain(input[3])
		expect(cleaned).toContain(input[4])
		expect(cleaned).toContain(imageFollowup)
		expect(projectSessionCompactionState(checkpoint, resumed)).toEqual([
			...checkpoint.messages,
			expect.objectContaining(imageFollowup),
		])
		const twice = agentMessagesToMessagesWithMetadata(
			messagesToAgentMessages(sanitizeInitialMessagesForSessionStart(resumed)),
		)
		expect(projectSessionCompactionState(checkpoint, twice)).toEqual(projectSessionCompactionState(checkpoint, resumed))
		expect(input).toEqual(original)
	})

	it("keeps separate human and system envelopes when a legacy tool result is missing", () => {
		const human = { id: "human", role: "user", ts: 20, metadata: { humanInput: true }, content: "continue" }
		const system = { id: "system", role: "user", metadata: { displayRole: "system" }, content: "runtime note" }
		const input = [
			{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "read_files", input: {} }] },
			human,
			system,
		]
		const result = sanitizeInitialMessagesForSessionStart(input)
		expect(result).toHaveLength(4)
		expect(result[1]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "a" }] })
		expect(result[1]).not.toHaveProperty("metadata")
		expect(result[2]).toBe(human)
		expect(result[3]).toBe(system)
	})

	it("preserves metadata and distinct identities when splitting mixed legacy content", () => {
		const input = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "a", name: "read_files", input: {} },
					{ type: "tool_use", id: "b", name: "read_files", input: {} },
				],
			},
			{
				id: "mixed",
				role: "user",
				ts: 20,
				metadata: { userRunSpan: 1, humanInput: true },
				content: [
					{ type: "tool_result", tool_use_id: "a", name: "read_files", content: "A" },
					{ type: "text", text: "continue" },
				],
			},
		]
		const result = sanitizeInitialMessagesForSessionStart(input) as MessageWithMetadata[]
		expect(result[2]).toMatchObject({
			id: "mixed",
			ts: 20,
			metadata: input[1].metadata,
			content: [{ type: "text", text: "continue" }],
		})
		expect(result[1].metadata).toMatchObject({ userRunSpan: 0 })
		const resumed = messagesToAgentMessages(result)
		expect(new Set(resumed.map((message) => message.id)).size).toBe(resumed.length)
	})

	it("returns original array when no tool_use blocks exist", () => {
		const input = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		]
		const result = sanitizeInitialMessagesForSessionStart(input)
		expect(result).toBe(input)
	})

	it("adds missing tool_result blocks to the next user message", () => {
		const input = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_1",
						name: "read_file",
						input: { path: "a.ts" },
					},
				],
			},
			{
				role: "user",
				content: [{ type: "text", text: "continue" }],
			},
		]

		const result = sanitizeInitialMessagesForSessionStart(input)
		expect(result).not.toBe(input)

		const nextContent = (result[1] as { content: Array<Record<string, unknown>> }).content
		expect(nextContent).toEqual([
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "toolu_1",
				name: "read_file",
			}),
		])
		expect(result[2]).toMatchObject({
			role: "user",
			content: [expect.objectContaining({ type: "text", text: "continue" })],
		})
	})

	it("inserts synthetic user tool_result message when missing next user message", () => {
		const input = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_1",
						name: "read_file",
						input: { path: "a.ts" },
					},
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "extra" }] },
		]

		const result = sanitizeInitialMessagesForSessionStart(input)
		expect(result).toHaveLength(3)
		expect(result[1]).toMatchObject({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_1", name: "read_file" }],
		})
	})

	it("consolidates parallel tool results spread across separate user messages (ENG-1885)", () => {
		// The SDK persists each parallel tool result as a separate user message.
		// The sanitizer must collect them all, not just the first one.
		const input = [
			{ role: "user", content: [{ type: "text", text: "list /usr" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I'll list several directories." },
					{
						type: "tool_use",
						id: "toolu_A",
						name: "execute_command",
						input: { command: "ls /usr/bin" },
					},
					{
						type: "tool_use",
						id: "toolu_B",
						name: "execute_command",
						input: { command: "ls /usr/lib" },
					},
					{
						type: "tool_use",
						id: "toolu_C",
						name: "execute_command",
						input: { command: "ls /usr/share" },
					},
				],
			},
			// SDK persists each tool result as a separate user message
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_A",
						content: "bin contents",
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_B",
						content: "lib contents",
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_C",
						content: "share contents",
					},
				],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Here are the results." }],
			},
		]

		const result = sanitizeInitialMessagesForSessionStart(input)

		// Should consolidate the 3 separate user messages into 1
		expect(result).toHaveLength(4) // user, assistant(3 tools), user(3 results), assistant
		const toolResultMsg = result[2] as {
			content: Array<Record<string, unknown>>
		}
		expect(toolResultMsg.content).toHaveLength(3)
		expect(toolResultMsg.content[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_A",
			content: "bin contents",
		})
		expect(toolResultMsg.content[1]).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_B",
			content: "lib contents",
		})
		expect(toolResultMsg.content[2]).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_C",
			content: "share contents",
		})

		// Verify no duplicates: count tool_result blocks across all messages
		const allToolResultIds = (result as Array<{ role: string; content: unknown }>).flatMap((msg) => {
			if (!Array.isArray(msg.content)) return []
			return msg.content.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id)
		})
		const uniqueIds = new Set(allToolResultIds)
		expect(allToolResultIds.length).toBe(uniqueIds.size) // no duplicates
	})

	it("reorders existing tool_result blocks to match tool_use order", () => {
		const input = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_1",
						name: "read_file",
						input: { path: "a.ts" },
					},
					{
						type: "tool_use",
						id: "toolu_2",
						name: "read_file",
						input: { path: "b.ts" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_2", content: "b" },
					{ type: "text", text: "keep me" },
					{ type: "tool_result", tool_use_id: "toolu_1", content: "a" },
				],
			},
		]

		const result = sanitizeInitialMessagesForSessionStart(input)
		const nextContent = (result[1] as { content: Array<Record<string, unknown>> }).content
		expect(nextContent[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_1",
		})
		expect(nextContent[1]).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_2",
		})
		expect(nextContent[2]).toMatchObject({ type: "text", text: "keep me" })
	})

	it("backfills missing tool_result names from matching assistant tool_use blocks", () => {
		const input = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_1",
						name: "read_file",
						input: { path: "a.ts" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: "file contents",
					},
				],
			},
		]

		const result = sanitizeInitialMessagesForSessionStart(input)
		const nextContent = (result[1] as { content: Array<Record<string, unknown>> }).content
		expect(nextContent[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_1",
			name: "read_file",
			content: "file contents",
		})
	})
})
