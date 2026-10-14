import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	RequestInputTokenCount,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./index";

class HeadroomModel implements AgentModel {
	requests: AgentModelRequest[] = [];
	counts: AgentModelRequest[] = [];
	constructor(
		readonly inputTokens: number | undefined,
		readonly failCount = false,
	) {}
	async countInputTokens(
		request: AgentModelRequest,
	): Promise<RequestInputTokenCount | undefined> {
		this.counts.push(request);
		if (this.failCount) throw new Error("counter unavailable");
		if (this.inputTokens === undefined) return undefined;
		return {
			inputTokens: this.inputTokens,
			source: "tokenized",
			fingerprint: "test",
			budgetRevision: "test",
			maxInputTokens: 73727,
			maxOutputTokens: 8192,
			contextWindow: 81920,
			compactionBufferTokens: 2048,
			serverBoundaryTokens: 1,
		};
	}
	async *stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent> {
		this.requests.push(request);
		yield {
			type: "text-delta",
			text: this.requests.length === 1 ? "Partial diagnosis." : "Finished.",
		};
		yield {
			type: "finish",
			reason: this.requests.length === 1 ? "max-tokens" : "stop",
		};
	}
}

describe("output truncation does not erase task context without input pressure", () => {
	it.each([
		36158,
		undefined,
	])("continues with history at measured input %s", async (inputTokens) => {
		const model = new HeadroomModel(inputTokens);
		const prepareTurn = vi.fn(async (input: { overflowRecovery?: boolean }) =>
			input.overflowRecovery ? { messages: [] } : undefined,
		);
		const runtime = new AgentRuntime({
			model,
			prepareTurn,
			hooks: {
				beforeModel: async ({ request }) => ({
					...request,
					messages: [
						...request.messages,
						{
							id: "dynamic",
							createdAt: 0,
							role: "user",
							content: [
								{ type: "text", text: "Host context: keep the verified edit." },
							],
						},
					],
				}),
			},
		});
		const output = await runtime.run(
			"Keep LogSink and commit the verified fix.",
		);
		expect(output.status).toBe("completed");
		expect(
			prepareTurn.mock.calls.some(([input]) => input.overflowRecovery),
		).toBe(false);
		expect(model.counts[0].messages).toEqual(model.requests[0].messages);
		expect(model.counts[0].tools).toEqual(model.requests[0].tools);
		expect(JSON.stringify(model.requests[1].messages)).toContain(
			"Keep LogSink",
		);
		expect(JSON.stringify(model.requests[1].messages)).toContain(
			"Partial diagnosis.",
		);
		expect(JSON.stringify(model.counts[0].messages)).toContain("Host context");
	});
	it("keeps history if the counter fails rather than inferring an input overflow", async () => {
		const model = new HeadroomModel(36158, true);
		const prepareTurn = vi.fn(
			async (_input: { overflowRecovery?: boolean }) => undefined,
		);
		const output = await new AgentRuntime({ model, prepareTurn }).run(
			"Retain the saved edits.",
		);
		expect(output.status).toBe("completed");
		expect(
			prepareTurn.mock.calls.every(
				([input]) =>
					!(input as { overflowRecovery?: boolean }).overflowRecovery,
			),
		).toBe(true);
		expect(JSON.stringify(model.requests[1].messages)).toContain(
			"Retain the saved edits.",
		);
	});
	it("still compacts and retries when measured input is near the limit", async () => {
		const model = new HeadroomModel(72000);
		const compacted = [
			{
				id: "summary",
				createdAt: 0,
				role: "user" as const,
				content: [{ type: "text" as const, text: "Verified checkpoint." }],
			},
		];
		const prepareTurn = vi.fn(async (input: { overflowRecovery?: boolean }) =>
			input.overflowRecovery ? { messages: compacted } : undefined,
		);
		const output = await new AgentRuntime({ model, prepareTurn }).run(
			"Long task ".repeat(200),
		);
		expect(output.status).toBe("completed");
		expect(
			prepareTurn.mock.calls.some(([input]) => input.overflowRecovery),
		).toBe(true);
		expect(model.requests[1].messages).toEqual(compacted);
	});
});
