import { setTimeout as delay } from "node:timers/promises";
import type { AgentTool } from "@cline/shared";

export type JobWaitRequest = NonNullable<
	ReturnType<NonNullable<AgentTool["waiting"]>["request"]>
>;
export type JobWaitObservation = NonNullable<
	ReturnType<NonNullable<AgentTool["waiting"]>["observe"]>
>;
export const DEFAULT_JOB_WAIT_BUDGET_MS = 30 * 60_000;
export const MAX_JOB_WAIT_MS = 60_000;

/** Adapter contract shared by local commands and remote expert status. */
export async function waitForJobStatus<T>(options: {
	request: JobWaitRequest;
	read: (remainingMs: number, signal: AbortSignal) => Promise<T>;
	observe: (output: T) => JobWaitObservation | undefined;
	signal?: AbortSignal;
	/** Expert status batches routine progress; command waits can wake on new output. */
	wakeOnProgress?: boolean;
}): Promise<T> {
	const { request } = options;
	if (
		!Number.isSafeInteger(request.waitMs) ||
		request.waitMs < 0 ||
		request.waitMs > MAX_JOB_WAIT_MS
	)
		throw new Error("wait_seconds must be an integer between 0 and 60");
	const deadline = performance.now() + request.waitMs;
	const timeoutSignal = AbortSignal.timeout(request.waitMs + 1000);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeoutSignal])
		: timeoutSignal;
	let baseline = request.afterRevision;
	for (;;) {
		signal?.throwIfAborted();
		const output = await options.read(
			Math.max(0, deadline - performance.now()),
			signal,
		);
		signal?.throwIfAborted();
		const observation = options.observe(output);
		// A malformed/error response is returned unchanged; it never proves a valid wait.
		if (!observation || observation.jobId !== request.jobId) return output;
		baseline ??= observation.revision;
		if (
			observation.state !== "running" ||
			(options.wakeOnProgress !== false && observation.revision > baseline) ||
			performance.now() >= deadline
		)
			return output;
		await delay(
			Math.min(250, Math.max(0, deadline - performance.now())),
			undefined,
			{ signal },
		);
	}
}

export function parseJobWaitRequest(
	input: unknown,
): JobWaitRequest | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return;
	const v = input as Record<string, unknown>;
	if (
		Object.keys(v).some(
			(key) => !["job_id", "wait_seconds", "after_revision"].includes(key),
		)
	)
		return;
	const seconds = v.wait_seconds === undefined ? 60 : v.wait_seconds;
	if (
		typeof v.job_id !== "string" ||
		!v.job_id.trim() ||
		!Number.isSafeInteger(seconds) ||
		Number(seconds) < 0 ||
		Number(seconds) > 60 ||
		(v.after_revision !== undefined &&
			(!Number.isSafeInteger(v.after_revision) || Number(v.after_revision) < 0))
	)
		return;
	return {
		jobId: v.job_id,
		waitMs: Number(seconds) * 1000,
		...(v.after_revision === undefined
			? {}
			: { afterRevision: Number(v.after_revision) }),
	};
}

export function parseJobWaitObservation(
	output: unknown,
): JobWaitObservation | undefined {
	if (!output || typeof output !== "object" || Array.isArray(output)) return;
	const v = output as Record<string, unknown>;
	if (v.isError === true) return;
	if (
		typeof v.job_id !== "string" ||
		!v.job_id.trim() ||
		!Number.isSafeInteger(v.revision) ||
		Number(v.revision) < 0 ||
		![
			"running",
			"completed",
			"failed",
			"cancelled",
			"waiting_for_input",
		].includes(String(v.state))
	)
		return;
	return {
		jobId: v.job_id,
		revision: Number(v.revision),
		state: v.state as JobWaitObservation["state"],
	};
}

export function createJobWaitCapability(
	options: {
		observe?: (output: unknown) => JobWaitObservation | undefined;
		maxWaitMs?: number;
	} = {},
): NonNullable<AgentTool["waiting"]> {
	const maxWaitMs = options.maxWaitMs ?? DEFAULT_JOB_WAIT_BUDGET_MS;
	if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs <= 0)
		throw new Error("Invalid job wait budget");
	return {
		request: parseJobWaitRequest,
		observe: options.observe ?? parseJobWaitObservation,
		maxWaitMs,
	};
}
