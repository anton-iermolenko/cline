import {
	type AgentTool,
	createTool,
	getDefaultShell,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import {
	type BackgroundCommandJobs,
	backgroundCommandJobs,
	backgroundJobWaitCapability,
} from "./background-jobs";
import type { ShellExecutor } from "./types";

const StartInput = z.object({ command: z.string().min(1) }).strict();
const WaitInput = z
	.object({
		job_id: z.string().min(1),
		wait_seconds: z.number().int().min(0).max(60).optional(),
		after_revision: z.number().int().nonnegative().optional(),
	})
	.strict();
const CancelInput = z.object({ job_id: z.string().min(1) }).strict();

export function createBackgroundCommandTools(
	executor: ShellExecutor,
	options: {
		cwd?: string;
		shell?: string;
		jobs?: BackgroundCommandJobs;
		timeoutMs?: number;
	} = {},
): AgentTool[] {
	const jobs = options.jobs ?? backgroundCommandJobs;
	return [
		createTool<unknown, unknown>({
			name: "start_background_command",
			retryable: false,
			description: `Start one long-running non-interactive command using ${options.shell ?? getDefaultShell(process.platform)}. Returns a job_id immediately. Use wait_for_job instead of sleep/tail polling. Jobs survive client reconnection in the same hub; cancelling a wait does not cancel the command.`,
			inputSchema: zodToJsonSchema(StartInput),
			execute: async (input, context) =>
				jobs.start(
					StartInput.parse(input).command,
					options.cwd ?? process.cwd(),
					executor,
					context,
					options.timeoutMs,
				),
		}),
		createTool<unknown, unknown>({
			name: "wait_for_job",
			executionMode: "sequential",
			retryable: false,
			timeoutMs: 65_000,
			waiting: backgroundJobWaitCapability,
			description:
				"Wait for a background command started by start_background_command. Use wait_seconds=60 and the last revision; wakes on new output or exit. Quiet running timeouts are successful waits. Use wait_seconds=0 only for an immediate snapshot. Keep repeated waits quiet. A failed job is reported with state and exit_code; it is distinct from failure to inspect the job.",
			inputSchema: zodToJsonSchema(WaitInput),
			execute: async (input, context) =>
				jobs.wait(WaitInput.parse(input), context),
		}),
		createTool<unknown, unknown>({
			name: "cancel_background_command",
			retryable: false,
			description:
				"Cancel a background command owned by this session. Cancellation is asynchronous; wait_for_job reports its terminal state.",
			inputSchema: zodToJsonSchema(CancelInput),
			execute: async (input, context) =>
				jobs.cancel(CancelInput.parse(input).job_id, context),
		}),
	];
}
