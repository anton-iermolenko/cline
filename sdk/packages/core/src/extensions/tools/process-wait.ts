import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AgentTool,
	type AgentToolContext,
	createTool,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import {
	type ProcessStartTokenProbeResult,
	probeProcessStartTokenAsync,
} from "../../runtime/process-start-token";
import {
	createJobWaitCapability,
	type JobWaitRequest,
	parseJobWaitObservation,
	waitForJobStatus,
} from "../../runtime/safety/job-wait";

const MAX_LOG_BYTES = 16 * 1024;
const MAX_PROCESSES_PER_SESSION = 128;
export const ProcessWaitInputSchema = z
	.object({
		pid: z.number().int().positive().max(2_147_483_647),
		log_path: z.string().min(1).optional(),
		wait_seconds: z.number().int().min(0).max(60).optional(),
		after_revision: z.number().int().nonnegative().optional(),
	})
	.strict();
export type ProcessWaitInput = z.infer<typeof ProcessWaitInputSchema>;
export interface ProcessWaitResult {
	pid: number;
	state: "running" | "exited" | "identity_changed" | "unavailable";
	revision: number;
	changed: boolean;
	/** An adopted non-child process does not expose a waitable exit status. */
	exit_code: null;
	output?: string;
	log_path?: string;
	log_error?: string;
	note: string;
}
export type ProcessWaitExecutor = (
	input: ProcessWaitInput,
	context: AgentToolContext,
) => Promise<ProcessWaitResult>;
interface LogSnapshot {
	text?: string;
	signature: string;
	error?: string;
}
export interface ProcessWaitOptions {
	probe?: (pid: number) => Promise<ProcessStartTokenProbeResult>;
	readLog?: (path: string) => Promise<LogSnapshot>;
}
interface Registration {
	token?: string;
	initiallyMissing: boolean;
	logPath?: string;
	revision: number;
	fingerprint?: string;
}

/** Bounded tail read; never follows a FIFO/device into a blocking read. */
async function readLogTail(path: string): Promise<LogSnapshot> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
		const stat = await file.stat();
		if (!stat.isFile())
			return {
				signature: "not-file",
				error: "log_path must be a regular file",
			};
		const bytes = Buffer.alloc(Math.min(MAX_LOG_BYTES, stat.size));
		const { bytesRead } = await file.read(
			bytes,
			0,
			bytes.length,
			Math.max(0, stat.size - bytes.length),
		);
		const captured = bytes.subarray(0, bytesRead);
		return {
			text:
				(stat.size > MAX_LOG_BYTES
					? "[Earlier log output omitted; showing bounded tail]\n"
					: "") + captured.toString("utf8"),
			signature: `${stat.dev}:${stat.ino}:${stat.size}:${createHash("sha256").update(captured).digest("hex")}`,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
		return {
			signature: `error:${code}`,
			error:
				code === "ENOENT"
					? "Log file does not exist yet"
					: `Unable to read log (${code})`,
		};
	} finally {
		await file?.close();
	}
}

function processJobId(pid: number): string {
	return `process:${pid}`;
}
export function processWaitRequest(input: unknown): JobWaitRequest | undefined {
	const parsed = ProcessWaitInputSchema.safeParse(input);
	if (!parsed.success) return;
	return {
		jobId: processJobId(parsed.data.pid),
		waitMs: (parsed.data.wait_seconds ?? 60) * 1000,
		...(parsed.data.after_revision === undefined
			? {}
			: { afterRevision: parsed.data.after_revision }),
	};
}
function processObservation(output: unknown) {
	// An unavailable identity probe is not evidence of a valid wait or process exit.
	if (
		output &&
		typeof output === "object" &&
		"state" in output &&
		output.state === "unavailable"
	)
		return;
	if (
		!output ||
		typeof output !== "object" ||
		!("pid" in output) ||
		!Number.isSafeInteger(output.pid) ||
		Number(output.pid) <= 0
	)
		return;
	return parseJobWaitObservation({
		...output,
		job_id: processJobId(Number(output.pid)),
	});
}
export const processWaitCapability = {
	...createJobWaitCapability({ observe: processObservation }),
	request: processWaitRequest,
};

/** Registrations stay pinned within the session, including after exit. A later
 * process inheriting the PID must never silently replace the original target. */
export class ProcessWaiter {
	private sessions = new Map<string, Map<number, Registration>>();
	constructor(private readonly options: ProcessWaitOptions = {}) {}

	async wait(
		input: ProcessWaitInput,
		context: AgentToolContext,
	): Promise<ProcessWaitResult> {
		const parsed = ProcessWaitInputSchema.parse(input);
		context.signal?.throwIfAborted();
		const owner =
			context.sessionId?.trim() ||
			context.conversationId?.trim() ||
			context.agentId;
		let processes = this.sessions.get(owner);
		if (!processes) {
			processes = new Map();
			this.sessions.set(owner, processes);
		}
		let registration = processes.get(parsed.pid);
		const logPath =
			parsed.log_path === undefined
				? undefined
				: resolve(context.cwd ?? process.cwd(), parsed.log_path);
		if (!registration) {
			if (processes.size >= MAX_PROCESSES_PER_SESSION)
				throw new Error("Process registration limit reached for this session");
			registration = { revision: 0, initiallyMissing: false, logPath };
			processes.set(parsed.pid, registration);
		} else if (logPath) {
			if (registration.logPath && registration.logPath !== logPath)
				throw new Error(
					"Use the original log_path for this process registration",
				);
			registration.logPath = logPath;
		}
		const target = registration;
		const request = processWaitRequest(parsed)!;
		return waitForJobStatus({
			request,
			signal: context.signal,
			observe: processObservation,
			read: async (_remaining, signal) => {
				let probe: ProcessStartTokenProbeResult;
				try {
					probe = await (this.options.probe ?? probeProcessStartTokenAsync)(
						parsed.pid,
					);
				} catch {
					probe = { status: "unavailable" };
				}
				signal.throwIfAborted();
				let state: ProcessWaitResult["state"];
				if (probe.status === "unavailable") state = "unavailable";
				else if (probe.status === "missing") {
					state = "exited";
					if (!target.token) target.initiallyMissing = true;
				} else if (
					target.initiallyMissing ||
					(target.token && target.token !== probe.token)
				)
					state = "identity_changed";
				else {
					target.token ??= probe.token;
					state = "running";
				}
				const log = target.logPath
					? await (this.options.readLog ?? readLogTail)(target.logPath)
					: undefined;
				signal.throwIfAborted();
				const fingerprint = JSON.stringify([
					state,
					target.token,
					log?.signature,
				]);
				if (
					target.fingerprint !== undefined &&
					target.fingerprint !== fingerprint
				)
					target.revision++;
				target.fingerprint = fingerprint;
				return {
					pid: parsed.pid,
					state,
					revision: target.revision,
					changed:
						parsed.after_revision === undefined ||
						target.revision > parsed.after_revision,
					exit_code: null,
					...(target.logPath ? { log_path: target.logPath } : {}),
					...(log?.error ? { log_error: log.error } : {}),
					...(log?.text !== undefined &&
					(parsed.after_revision === undefined ||
						target.revision > parsed.after_revision)
						? { output: log.text }
						: {}),
					note:
						state === "running"
							? "The registered process is still running. A quiet wait timeout is normal."
							: state === "exited"
								? "The process is no longer running. Its exit code and success/failure are unknown; inspect its completion record or log."
								: state === "identity_changed"
									? "This PID now belongs to a different process. The original process exit code is unknown."
									: "Process identity could not be inspected. This does not establish that the process exited.",
				};
			},
		});
	}
}

const defaultProcessWaiter = new ProcessWaiter();
export function createProcessWaitExecutor(
	options?: ProcessWaitOptions,
): ProcessWaitExecutor {
	const waiter = options ? new ProcessWaiter(options) : defaultProcessWaiter;
	return (input, context) => waiter.wait(input, context);
}
export function createWaitForProcessTool(
	executor: ProcessWaitExecutor,
	options: { cwd?: string } = {},
): AgentTool {
	return createTool<unknown, ProcessWaitResult>({
		name: "wait_for_process",
		retryable: false,
		executionMode: "sequential",
		timeoutMs: 65_000,
		waiting: processWaitCapability,
		description:
			"Wait for a process you launched through run_commands using its actual long-lived PID and optional log_path. First call pins its kernel start identity; later calls detect PID reuse. Use wait_seconds=60 and the last after_revision instead of repeated shell sleep/tail/ps checks. Wakes on log progress or exit; quiet timeouts are normal. Returns exited with exit_code=null when the process disappears: this does not prove success. wait_seconds=0 is an immediate snapshot. Cancelling this wait never kills the process. Inspect the log or a launch-written completion record for success/failure.",
		inputSchema: zodToJsonSchema(ProcessWaitInputSchema),
		execute: async (input, context) =>
			executor(ProcessWaitInputSchema.parse(input), {
				...context,
				cwd: context.cwd ?? options.cwd,
			}),
	});
}
