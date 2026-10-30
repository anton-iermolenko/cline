import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createShellTool } from "./definitions";
import { createShellExecutor } from "./executors/bash";
import { createProcessWaitExecutor } from "./process-wait";

const context: AgentToolContext = {
	agentId: "handoff-test",
	conversationId: "handoff-test",
	iteration: 1,
};
function handle(text: string) {
	const pid = Number(text.match(/Background PID: (\d+)/)?.[1]);
	const log = text.match(/Output will continue in (.+)]/)?.[1];
	if (!pid || !log) throw new Error("Expected actual PID and log handoff");
	return { pid, log_path: log };
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe.skipIf(process.platform === "win32")(
	"automatic foreground handoff",
	() => {
		it.each([
			0, 7,
		])("keeps one process alive, waits by PID and records its eventual exit %i", async (code) => {
			const directory = await mkdtemp(join(tmpdir(), "cline-handoff-proof-"));
			const starts = join(directory, "starts");
			let job: ReturnType<typeof handle> | undefined;
			try {
				const executor = createShellExecutor({ timeoutMs: 5000 });
				const tool = createShellTool(executor, { bashTimeoutMs: 500 });
				expect(tool.description).toContain("foreground wait limit");
				const result = await tool.execute(
					{
						commands: [
							{
								command: process.execPath,
								args: [
									"-e",
									`require('node:fs').appendFileSync(${JSON.stringify(starts)},'start\\n');console.log('started:'+process.pid);setTimeout(()=>{console.error('finished');process.exit(${code})},1600)`,
								],
							},
						],
					},
					context,
				);
				expect(result[0].success).toBe(true);
				expect(result[0].result).toContain("command has not completed");
				const text = result[0].result;
				if (typeof text !== "string")
					throw new Error("Expected text handoff result");
				job = handle(text);
				expect(existsSync(job.log_path)).toBe(true);
				expect(result[0].result).toContain(`started:${job.pid}`);
				expect(alive(job.pid)).toBe(true);
				const wait = createProcessWaitExecutor();
				expect((await wait({ ...job, wait_seconds: 0 }, context)).state).toBe(
					"running",
				);
				const done = await wait({ ...job, wait_seconds: 3 }, context);
				expect(done.state).toBe("exited");
				expect(done.exit_code).toBeNull();
				await expect
					.poll(async () => await readFile(job!.log_path, "utf8"))
					.toContain(`Command exited with code ${code}`);
				expect(await readFile(job.log_path, "utf8")).toContain("finished");
				expect(await readFile(starts, "utf8")).toBe("start\n");
			} finally {
				if (job && alive(job.pid)) process.kill(job.pid, "SIGKILL");
				if (job)
					await rm(dirname(job.log_path), { recursive: true, force: true });
				await rm(directory, { recursive: true, force: true });
			}
		});

		it("cancels foreground work before handoff", async () => {
			const abort = new AbortController();
			let pid = 0;
			let ready!: () => void;
			const started = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const executor = createShellExecutor({ timeoutMs: 5000 });
			const command = executor(
				{
					command: process.execPath,
					args: [
						"-e",
						"console.log('pid:'+process.pid);setTimeout(()=>{},10000)",
					],
				},
				process.cwd(),
				{
					...context,
					signal: abort.signal,
					emitUpdate: (u) => {
						const match = String((u as { chunk?: string }).chunk).match(
							/pid:(\d+)/,
						);
						if (match) {
							pid = Number(match[1]);
							ready();
						}
					},
				},
			);
			await started;
			abort.abort();
			await expect(command).rejects.toThrow("aborted");
			await expect.poll(() => alive(pid)).toBe(false);
		});

		it("cancelling a wait leaves the handed-off process running", async () => {
			const executor = createShellExecutor({ timeoutMs: 400 });
			const text = await executor(
				{ command: process.execPath, args: ["-e", "setTimeout(()=>{},2000)"] },
				process.cwd(),
				context,
			);
			const job = handle(text);
			expect(existsSync(job.log_path)).toBe(true);
			try {
				const wait = createProcessWaitExecutor();
				const abort = new AbortController();
				const pending = wait(
					{ ...job, wait_seconds: 60 },
					{ ...context, signal: abort.signal },
				);
				setTimeout(() => abort.abort(), 30);
				await expect(pending).rejects.toThrow();
				expect(alive(job.pid)).toBe(true);
				expect((await wait({ ...job, wait_seconds: 3 }, context)).state).toBe(
					"exited",
				);
			} finally {
				if (alive(job.pid)) process.kill(job.pid, "SIGKILL");
				await rm(dirname(job.log_path), { recursive: true, force: true });
			}
		});

		it("fails and cancels if it cannot create the background log", async () => {
			const directory = await mkdtemp(
				join(tmpdir(), "cline-handoff-log-error-"),
			);
			const previous = process.env.TMPDIR;
			let pid = 0;
			try {
				const executor = createShellExecutor({
					timeoutMs: 400,
					processStartTokenProbe: async (p) => {
						pid = p;
						process.env.TMPDIR = join(directory, "missing-directory");
						return { status: "found", token: "log-failure-test" };
					},
				});
				await expect(
					executor(
						{
							command: process.execPath,
							args: ["-e", "setTimeout(()=>{},10000)"],
						},
						process.cwd(),
						context,
					),
				).rejects.toThrow("handoff unavailable");
				await expect.poll(() => alive(pid)).toBe(false);
			} finally {
				if (previous === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = previous;
				await rm(directory, { recursive: true, force: true });
			}
		});
	},
);
