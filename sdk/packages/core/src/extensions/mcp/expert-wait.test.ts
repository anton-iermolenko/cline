import { describe, expect, it, vi } from "vitest";
import { expertWaitObservation } from "./expert-wait";
import { createMcpTools } from "./tools";

const context = { agentId: "a", iteration: 1 };
const envelope = (value: unknown) => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
});
const running = { job_id: "job", state: "running", revision: 8 };
async function fixture(
	serverName = "consult-expert",
	callTool = vi.fn(async () => envelope(running)),
) {
	const tools = await createMcpTools({
		serverName,
		nameTransform: () => "renamed_status",
		provider: {
			listTools: async () => [
				{ name: "expert_status", inputSchema: { type: "object" } },
			],
			callTool,
		},
	});
	return { tool: tools[0], callTool };
}
describe("expert adapter for shared job waits", () => {
	it("uses trusted registration identity instead of transformed tool names", async () => {
		expect((await fixture()).tool.waiting).toBeDefined();
		expect((await fixture("other-server")).tool.waiting).toBeUndefined();
	});
	it("preserves readiness and explicit snapshots, including provider output identity", async () => {
		const response = envelope(running);
		const { tool, callTool } = await fixture(
			"consult-expert",
			vi.fn(async () => response),
		);
		expect(await tool.execute({}, context)).toBe(response);
		expect(
			await tool.execute({ job_id: "job", wait_seconds: 0 }, context),
		).toBe(response);
		expect(callTool).toHaveBeenCalledTimes(2);
	});
	it("batches routine expert progress for the requested interval", async () => {
		const { tool, callTool } = await fixture();
		const started = performance.now();
		const response = await tool.execute(
			{ job_id: "job", wait_seconds: 1, after_revision: 1 },
			context,
		);
		expect(response).toEqual(envelope(running));
		expect(performance.now() - started).toBeGreaterThanOrEqual(990);
		expect(callTool.mock.calls.length).toBeLessThanOrEqual(6);
	});
	it.each([
		"completed",
		"failed",
		"cancelled",
		"unavailable",
		"waiting_for_user",
	])("returns %s without waiting and preserves the response", async (state) => {
		const response = envelope({
			...running,
			state,
			report: "full report",
			request: { question: "which?" },
		});
		const { tool, callTool } = await fixture(
			"consult-expert",
			vi.fn(async () => response),
		);
		expect(
			await tool.execute({ job_id: "job", wait_seconds: 60 }, context),
		).toBe(response);
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(expertWaitObservation(response)).toBeDefined();
	});
	it("does not validate MCP errors, invalid job IDs, or prose as a status", () => {
		expect(
			expertWaitObservation({ ...envelope(running), isError: true }),
		).toBeUndefined();
		expect(
			expertWaitObservation(envelope({ state: "running" })),
		).toBeUndefined();
		expect(
			expertWaitObservation({
				content: [{ type: "text", text: "job is running" }],
			}),
		).toBeUndefined();
	});
});
