import { createAgentRuntime } from "@cline/agents";
import type { AgentModel, AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	createJobWaitCapability,
	parseJobWaitObservation,
	waitForJobStatus,
} from "../safety/job-wait";
import { SessionRuntime } from "./session-runtime-orchestrator";

async function runCalls(tool: AgentTool, inputs: unknown[]) {
	let turn = 0;
	const model: AgentModel = {
		async stream() {
			return (async function* () {
				const index = turn++;
				if (index < inputs.length) {
					yield {
						type: "tool-call-delta" as const,
						toolCallId: `call-${index}`,
						toolName: tool.name,
						inputText: JSON.stringify(inputs[index]),
					};
					yield { type: "finish" as const, reason: "tool-calls" as const };
				} else {
					yield { type: "text-delta" as const, text: "done" };
					yield { type: "finish" as const, reason: "stop" as const };
				}
			})();
		},
	};
	const errors: string[] = [];
	const session = new SessionRuntime(
		{
			providerId: "cline",
			modelId: "openai/gpt-5.5",
			apiKey: "test-key",
			systemPrompt: "test",
			tools: [tool],
			execution: { maxConsecutiveMistakes: 3 },
		},
		{
			createAgentRuntimeImpl: (config) =>
				createAgentRuntime({ ...config, model }),
		},
	);
	session.subscribeEvents((event) => {
		if (event.type === "error") errors.push(event.error.message);
	});
	const result = await session.run("wait for the job");
	return { result, errors, turns: turn };
}
describe("job waits through the real agent runtime", () => {
	it("allows more than five identical quiet waits without a mistake-limit abort", async () => {
		const observation = { job_id: "job", state: "running", revision: 0 };
		const capability = createJobWaitCapability();
		const tool: AgentTool = {
			name: "wait",
			description: "wait",
			inputSchema: { type: "object" },
			waiting: { ...capability, request: () => ({ jobId: "job", waitMs: 25 }) },
			execute: async () =>
				waitForJobStatus({
					request: { jobId: "job", waitMs: 25 },
					read: async () => observation,
					observe: parseJobWaitObservation,
				}),
		};
		const { result, errors, turns } = await runCalls(
			tool,
			Array(7).fill({ job_id: "job" }),
		);
		expect(turns).toBe(8);
		expect(result.finishReason).toBe("completed");
		expect(errors).toEqual([]);
	});
	it("does not exempt immediate fake running responses even when wait_seconds varies", async () => {
		const tool: AgentTool = {
			name: "wait",
			description: "wait",
			inputSchema: { type: "object" },
			waiting: createJobWaitCapability(),
			execute: async () => ({ job_id: "job", state: "running", revision: 0 }),
		};
		const { result, errors } = await runCalls(
			tool,
			Array.from({ length: 7 }, (_, i) => ({
				job_id: "job",
				wait_seconds: 30 + i,
			})),
		);
		expect(result.finishReason).toBe("aborted");
		expect(
			errors.some((error) => error.includes("consecutive identical")),
		).toBe(true);
	});
	it("stops waiting on its own deadline without producing consecutive-mistake errors", async () => {
		const tool: AgentTool = {
			name: "wait",
			description: "wait",
			inputSchema: { type: "object" },
			waiting: {
				...createJobWaitCapability({ maxWaitMs: 1 }),
				request: () => ({ jobId: "job", waitMs: 25 }),
			},
			execute: async () =>
				waitForJobStatus({
					request: { jobId: "job", waitMs: 25 },
					read: async () => ({ job_id: "job", state: "running", revision: 0 }),
					observe: parseJobWaitObservation,
				}),
		};
		const { result, errors, turns } = await runCalls(
			tool,
			Array(7).fill({ job_id: "job" }),
		);
		expect(turns).toBe(1);
		expect(errors).toEqual([]);
		expect(JSON.stringify(result.messages)).toContain("wait_budget_exhausted");
		expect(JSON.stringify(result.messages)).not.toContain(
			"consecutive mistakes",
		);
	});
	it("keeps ordinary repeated commands protected", async () => {
		const tool: AgentTool = {
			name: "run_commands",
			description: "command",
			inputSchema: { type: "object" },
			execute: async () => "ok",
		};
		const { result, errors } = await runCalls(
			tool,
			Array(7).fill({ commands: ["echo repeat"] }),
		);
		expect(result.finishReason).toBe("aborted");
		expect(
			errors.some((error) => error.includes("consecutive identical")),
		).toBe(true);
	});
});
