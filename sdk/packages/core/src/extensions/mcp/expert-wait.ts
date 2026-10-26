import type { AgentTool, AgentToolContext } from "@cline/shared";
import {
	createJobWaitCapability,
	type JobWaitObservation,
	parseJobWaitObservation,
	parseJobWaitRequest,
	waitForJobStatus,
} from "../../runtime/safety/job-wait";

/** Decode MCP text/structured envelopes, never infer job state from arbitrary prose. */
export function expertWaitObservation(
	output: unknown,
): JobWaitObservation | undefined {
	if (!output || typeof output !== "object" || Array.isArray(output)) return;
	const v = output as Record<string, unknown>;
	if (v.isError === true) return;
	if (v.structuredContent) return expertWaitObservation(v.structuredContent);
	if (Array.isArray(v.content)) {
		for (const block of v.content) {
			if (block?.type !== "text" || typeof block.text !== "string") continue;
			try {
				const parsed = expertWaitObservation(JSON.parse(block.text));
				if (parsed) return parsed;
			} catch {
				/* Not a status response. */
			}
		}
	}
	return parseJobWaitObservation({
		...v,
		state:
			v.state === "waiting_for_user"
				? "waiting_for_input"
				: v.state === "unavailable"
					? "failed"
					: v.state,
	});
}

export function withExpertJobWait(tool: AgentTool): AgentTool {
	const execute = tool.execute;
	return {
		...tool,
		waiting: createJobWaitCapability({ observe: expertWaitObservation }),
		timeoutMs: Math.max(tool.timeoutMs ?? 0, 65_000),
		retryable: false,
		executionMode: "sequential",
		execute: async (input: unknown, context: AgentToolContext) => {
			const request = parseJobWaitRequest(input);
			if (!request || request.waitMs === 0) return execute(input, context);
			return waitForJobStatus({
				request,
				signal: context.signal,
				wakeOnProgress: false,
				observe: expertWaitObservation,
				read: async (remaining, signal) =>
					execute(
						{
							...(input as Record<string, unknown>),
							wait_seconds: Math.ceil(remaining / 1000),
						},
						{ ...context, signal },
					),
			});
		},
	};
}
