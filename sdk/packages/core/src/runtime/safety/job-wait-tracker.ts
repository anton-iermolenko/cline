import type { AgentTool } from "@cline/shared";
import { DEFAULT_JOB_WAIT_BUDGET_MS, type JobWaitRequest } from "./job-wait";

/** Per-session deadline and last verified revision; changing wait duration cannot reset either. */
export class JobWaitTracker {
	private jobs = new Map<
		string,
		{ startedAt: number; revision?: number; state?: string }
	>();

	inspect(
		tool: AgentTool,
		request: JobWaitRequest,
		output: unknown,
		durationMs: number,
	): "valid" | "invalid" | "deadline" {
		const observation = tool.waiting?.observe(output);
		if (!observation || observation.jobId !== request.jobId) return "invalid";
		const key = JSON.stringify([tool.name, request.jobId]);
		const now = performance.now();
		let job = this.jobs.get(key);
		if (!job) {
			// Count time already spent in the first blocking call, including tool setup.
			job = { startedAt: now - durationMs };
			this.jobs.set(key, job);
		}
		const previousRevision = job.revision ?? request.afterRevision;
		const progress =
			previousRevision !== undefined && observation.revision > previousRevision;
		if (job.revision !== undefined && observation.revision < job.revision)
			return "invalid";
		const terminalChanged =
			observation.state !== "running" &&
			(job.state !== observation.state ||
				job.revision !== observation.revision);
		job.revision = observation.revision;
		job.state = observation.state;
		if (
			observation.state === "running" &&
			now - job.startedAt >=
				(tool.waiting?.maxWaitMs ?? DEFAULT_JOB_WAIT_BUDGET_MS)
		)
			return "deadline";
		// A successful snapshot is not automatically a wait. Running responses must
		// advance the verified revision or have spent the requested interval waiting.
		return terminalChanged ||
			progress ||
			(observation.state === "running" && durationMs + 10 >= request.waitMs)
			? "valid"
			: "invalid";
	}

	reset(): void {
		this.jobs.clear();
	}
}
