import { randomUUID } from "node:crypto";
import type { AgentToolContext } from "@cline/shared";
import {
	createJobWaitCapability,
	parseJobWaitObservation,
	parseJobWaitRequest,
	waitForJobStatus,
} from "../../runtime/safety/job-wait";
import { CommandExitError, CommandTerminationError } from "./executors/bash";
import {
	MAX_COMMAND_OUTPUT_CHARS,
	truncateCommandOutput,
} from "./executors/output-limits";
import type { ShellExecutor } from "./types";

export const DEFAULT_BACKGROUND_COMMAND_TIMEOUT_MS = 60 * 60_000;
const COMPLETED_JOB_RETENTION_MS = 60 * 60_000;
const MAX_JOBS_PER_SESSION = 32;
class CommandDeadlineError extends Error {}
type Job = {
	job_id: string;
	owner: string;
	state: "running" | "completed" | "failed" | "cancelled";
	revision: number;
	output: string;
	exit_code?: number;
	error?: string;
	finishedAt?: number;
	controller: AbortController;
};
function owner(context: AgentToolContext): string {
	return context.sessionId ?? context.conversationId ?? context.agentId;
}

/** Hub-process scoped. Session ownership survives toolset rebuilds; missing jobs after
 * a hub restart fail explicitly rather than claiming an unverified process is running. */
export class BackgroundCommandJobs {
	private jobs = new Map<string, Job>();

	start(
		command: string,
		cwd: string,
		executor: ShellExecutor,
		context: AgentToolContext,
		timeoutMs = DEFAULT_BACKGROUND_COMMAND_TIMEOUT_MS,
	) {
		context.signal?.throwIfAborted();
		const session = owner(context);
		for (const [id, job] of this.jobs)
			if (
				job.finishedAt &&
				Date.now() - job.finishedAt > COMPLETED_JOB_RETENTION_MS
			)
				this.jobs.delete(id);
		const owned = [...this.jobs.values()].filter(
			(job) => job.owner === session,
		);
		while (owned.length >= MAX_JOBS_PER_SESSION) {
			const oldest = owned.findIndex((job) => job.state !== "running");
			if (oldest === -1)
				throw new Error(
					"Background job limit reached; wait for or cancel existing jobs before starting more.",
				);
			this.jobs.delete(owned.splice(oldest, 1)[0].job_id);
		}
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
			throw new Error("Invalid background command execution budget");
		const job: Job = {
			job_id: randomUUID(),
			owner: session,
			state: "running",
			revision: 0,
			output: "",
			controller: new AbortController(),
		};
		this.jobs.set(job.job_id, job);
		const timer = setTimeout(
			() =>
				job.controller.abort(
					new CommandDeadlineError(
						"Background command execution deadline reached",
					),
				),
			timeoutMs,
		);
		timer.unref();
		void Promise.resolve()
			.then(() =>
				executor(command, cwd, {
					...context,
					toolCallId: undefined,
					signal: job.controller.signal,
					emitUpdate: (update) => {
						if (
							update &&
							typeof update === "object" &&
							"chunk" in update &&
							typeof update.chunk === "string" &&
							update.chunk
						) {
							job.output = truncateCommandOutput(job.output + update.chunk, {
								maxChars: MAX_COMMAND_OUTPUT_CHARS,
							});
							job.revision++;
						}
					},
				}),
			)
			.then(
				(output) => {
					job.output = truncateCommandOutput(output, {
						maxChars: MAX_COMMAND_OUTPUT_CHARS,
					});
					job.state = "completed";
					job.exit_code = 0;
				},
				(error: unknown) => {
					const reason = job.controller.signal.aborted
						? job.controller.signal.reason
						: error;
					job.state =
						job.controller.signal.aborted &&
						!(reason instanceof CommandDeadlineError)
							? "cancelled"
							: "failed";
					job.error = reason instanceof Error ? reason.message : String(reason);
					if (error instanceof CommandExitError) job.exit_code = error.exitCode;
					if (
						error instanceof CommandExitError ||
						error instanceof CommandTerminationError
					)
						job.output = truncateCommandOutput(error.output, {
							maxChars: MAX_COMMAND_OUTPUT_CHARS,
						});
				},
			)
			.finally(() => {
				clearTimeout(timer);
				job.finishedAt = Date.now();
				job.revision++;
			});
		return this.snapshot(job, undefined);
	}

	private get(jobId: string, context: AgentToolContext): Job {
		const job = this.jobs.get(jobId);
		if (!job || job.owner !== owner(context))
			throw new Error(
				"Unknown background job in this session. Jobs are retained in the current hub process only.",
			);
		return job;
	}
	private snapshot(job: Job, afterRevision: number | undefined) {
		return {
			job_id: job.job_id,
			state: job.state,
			revision: job.revision,
			changed: afterRevision === undefined || job.revision > afterRevision,
			...(afterRevision === undefined || job.revision > afterRevision
				? { output: job.output }
				: {}),
			...(job.exit_code === undefined ? {} : { exit_code: job.exit_code }),
			...(job.error ? { command_error: job.error } : {}),
		};
	}
	async wait(input: unknown, context: AgentToolContext) {
		const request = parseJobWaitRequest(input);
		if (!request) throw new Error("Invalid job wait arguments");
		this.get(request.jobId, context);
		return waitForJobStatus({
			request,
			signal: context.signal,
			observe: parseJobWaitObservation,
			read: async () =>
				this.snapshot(this.get(request.jobId, context), request.afterRevision),
		});
	}
	cancel(jobId: string, context: AgentToolContext) {
		const job = this.get(jobId, context);
		if (job.state === "running")
			job.controller.abort(new Error("Background command cancelled"));
		return this.snapshot(job, undefined);
	}
}

export const backgroundCommandJobs = new BackgroundCommandJobs();
export const backgroundJobWaitCapability = createJobWaitCapability();
