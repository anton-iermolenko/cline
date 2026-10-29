import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentToolContext } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createShellTool } from "./definitions";
import { createShellExecutor } from "./executors/bash";
import { createBuiltinTools } from "./index";
import {
	createProcessWaitExecutor,
	createWaitForProcessTool,
	ProcessWaiter,
	processWaitRequest,
} from "./process-wait";
import { getCoreBuiltinToolCatalog } from "./runtime";

const context: AgentToolContext = {
	sessionId: "session",
	agentId: "agent",
	iteration: 1,
};
const found = { status: "found" as const, token: "generation-one" };
describe("PID-based process waiting", () => {
	it("pins the first observed identity and detects a reused PID without adopting it", async () => {
		const probe = vi.fn(async () => found);
		const waiter = new ProcessWaiter({ probe });
		expect(
			await waiter.wait({ pid: 123, wait_seconds: 0 }, context),
		).toMatchObject({ state: "running", revision: 0, exit_code: null });
		probe.mockResolvedValue({ ...found, token: "generation-two" });
		expect(
			await waiter.wait({ pid: 123, wait_seconds: 60 }, context),
		).toMatchObject({
			state: "identity_changed",
			revision: 1,
			exit_code: null,
		});
		expect(
			await waiter.wait({ pid: 123, wait_seconds: 0 }, context),
		).toMatchObject({ state: "identity_changed" });
	});
	it("reports an absent or zombie process as exited with unknown outcome", async () => {
		const waiter = new ProcessWaiter({
			probe: async () => ({ status: "missing" }),
		});
		const result = await waiter.wait({ pid: 123, wait_seconds: 60 }, context);
		expect(result).toMatchObject({ state: "exited", exit_code: null });
		expect(result.note).toContain("success/failure are unknown");
	});
	it("does not adopt a later process when the PID was missing at registration", async () => {
		let missing = true;
		const waiter = new ProcessWaiter({
			probe: async () => (missing ? { status: "missing" } : found),
		});
		await waiter.wait({ pid: 123, wait_seconds: 0 }, context);
		missing = false;
		expect(
			await waiter.wait({ pid: 123, wait_seconds: 0 }, context),
		).toMatchObject({ state: "identity_changed" });
	});
	it("distinguishes unavailable inspection from exit and does not exempt it", async () => {
		const tool = createWaitForProcessTool(
			createProcessWaitExecutor({
				probe: async () => ({ status: "unavailable" }),
			}),
		);
		const result = await tool.execute({ pid: 123, wait_seconds: 60 }, context);
		expect(result).toMatchObject({ state: "unavailable", exit_code: null });
		expect(tool.waiting?.observe(result)).toBeUndefined();
	});
	it("allows a quiet running timeout without claiming progress", async () => {
		const waiter = new ProcessWaiter({ probe: async () => found });
		const started = performance.now();
		expect(
			await waiter.wait(
				{ pid: 123, wait_seconds: 1, after_revision: 0 },
				context,
			),
		).toMatchObject({ state: "running", revision: 0, changed: false });
		expect(performance.now() - started).toBeGreaterThanOrEqual(990);
	});
	it.each([
		undefined,
		0,
	])("batches continuous log progress until the deadline (after_revision: %s)", async (afterRevision) => {
		let reads = 0;
		const waiter = new ProcessWaiter({
			probe: async () => found,
			readLog: async () => {
				const text = `batch ${++reads}`;
				return { text, signature: text };
			},
		});
		const started = performance.now();
		const result = await waiter.wait(
			{
				pid: 123,
				log_path: "run.log",
				wait_seconds: 1,
				after_revision: afterRevision,
			},
			{ ...context, cwd: "/tmp" },
		);
		expect(performance.now() - started).toBeGreaterThanOrEqual(990);
		expect(reads).toBeGreaterThan(1);
		expect(result).toMatchObject({
			state: "running",
			changed: true,
			output: `batch ${reads}`,
		});
		expect(result.revision).toBeGreaterThan(0);
		await expect(
			waiter.wait(
				{ pid: 123, log_path: "other.log", wait_seconds: 0 },
				{ ...context, cwd: "/tmp" },
			),
		).rejects.toThrow("original log_path");
	});
	it.each([
		"exited",
		"identity_changed",
		"unavailable",
	] as const)("returns %s before the deadline even with continuous output", async (state) => {
		let probes = 0,
			reads = 0;
		const waiter = new ProcessWaiter({
			probe: async () =>
				++probes < 3
					? found
					: state === "exited"
						? { status: "missing" }
						: state === "unavailable"
							? { status: "unavailable" }
							: { ...found, token: "generation-two" },
			readLog: async () => {
				const text = `batch ${++reads}`;
				return { text, signature: text };
			},
		});
		const result = await waiter.wait(
			{ pid: 123, log_path: "run.log", wait_seconds: 60 },
			context,
		);
		expect(result).toMatchObject({ state, exit_code: null });
		expect(probes).toBe(3);
	});
	it("keeps registrations separate between sessions and stable across executor rebuilds", async () => {
		const waiter = new ProcessWaiter({ probe: async () => found });
		await waiter.wait(
			{ pid: 123, log_path: "one.log", wait_seconds: 0 },
			context,
		);
		expect(
			await waiter.wait(
				{ pid: 123, log_path: "two.log", wait_seconds: 0 },
				{ ...context, sessionId: "other" },
			),
		).toMatchObject({ state: "running" });
		const first = createProcessWaitExecutor();
		const initial = await first(
			{ pid: process.pid, wait_seconds: 0 },
			{ ...context, sessionId: "rebuild" },
		);
		const next = await createProcessWaitExecutor()(
			{ pid: process.pid, wait_seconds: 0 },
			{ ...context, sessionId: "rebuild" },
		);
		expect(next.pid).toBe(initial.pid);
		expect(next.revision).toBe(initial.revision);
	});
	it("cancels only the wait and leaves its process observable", async () => {
		const waiter = new ProcessWaiter({ probe: async () => found });
		const controller = new AbortController();
		const pending = waiter.wait(
			{ pid: 123, wait_seconds: 60 },
			{ ...context, signal: controller.signal },
		);
		controller.abort(new Error("stop waiting"));
		await expect(pending).rejects.toThrow("stop waiting");
		expect(
			await waiter.wait({ pid: 123, wait_seconds: 0 }, context),
		).toMatchObject({ state: "running" });
	});
	it.each([
		{ pid: 0 },
		{ pid: -1 },
		{ pid: 1.5 },
		{ pid: "123" },
		{ pid: 123, wait_seconds: 61 },
		{ pid: 123, polling: true },
	])("validates PID and waiting inputs: %j", (input) => {
		expect(processWaitRequest(input)).toBeUndefined();
	});
	it("uses a stable wait identity when duration and revision arguments change", () => {
		expect(processWaitRequest({ pid: 123, wait_seconds: 20 })?.jobId).toBe(
			processWaitRequest({ pid: 123, wait_seconds: 60, after_revision: 8 })
				?.jobId,
		);
	});
	it("reads only a bounded regular log tail and tolerates a not-yet-created log", async () => {
		const directory = await mkdtemp(join(tmpdir(), "process-wait-log-"));
		try {
			const executor = createProcessWaitExecutor();
			const tool = createWaitForProcessTool(executor, { cwd: directory });
			const file = join(directory, "output.log");
			await writeFile(file, `${"x".repeat(100_000)}END`);
			const result = (await tool.execute(
				{ pid: process.pid, log_path: "output.log", wait_seconds: 0 },
				{ ...context, sessionId: "tail" },
			)) as { output: string };
			expect(result.output).toContain("Earlier log output omitted");
			expect(result.output.endsWith("END")).toBe(true);
			expect(result.output.length).toBeLessThan(17_000);
			expect(
				await tool.execute(
					{ pid: process.pid, log_path: "missing.log", wait_seconds: 0 },
					{ ...context, sessionId: "missing" },
				),
			).toMatchObject({
				state: "running",
				log_error: "Log file does not exist yet",
			});
			if (process.platform === "linux") {
				await promisify(execFile)("mkfifo", [join(directory, "pipe")]);
				expect(
					await tool.execute(
						{ pid: process.pid, log_path: "pipe", wait_seconds: 0 },
						{ ...context, sessionId: "pipe" },
					),
				).toMatchObject({
					state: "running",
					log_error: "log_path must be a regular file",
				});
			}
			await mkdir(join(directory, "not-file"));
			expect(
				await tool.execute(
					{ pid: process.pid, log_path: "not-file", wait_seconds: 0 },
					{ ...context, sessionId: "directory" },
				),
			).toMatchObject({
				state: "running",
				log_error: "log_path must be a regular file",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("offers one process-wait tool and no managed start/wait/cancel choices", () => {
		const names = createBuiltinTools().map((tool) => tool.name);
		expect(names).toContain("wait_for_process");
		for (const removed of [
			"start_background_command",
			"wait_for_job",
			"cancel_background_command",
		])
			expect(names).not.toContain(removed);
		expect(
			getCoreBuiltinToolCatalog({ mode: "yolo" }).find(
				(entry) => entry.id === "wait_for_process",
			)?.defaultEnabled,
		).toBe(true);
		expect(
			getCoreBuiltinToolCatalog().find(
				(entry) => entry.id === "background_commands",
			),
		).toBeUndefined();
		expect(
			createBuiltinTools({ enableProcessWait: false }).map((tool) => tool.name),
		).not.toContain("wait_for_process");
		expect(
			createBuiltinTools({ enableBash: false }).map((tool) => tool.name),
		).not.toContain("wait_for_process");
	});
	it("requires custom shell hosts to opt in with a matching process namespace", () => {
		expect(
			createBuiltinTools({ shell: "wsl.exe" }).map((tool) => tool.name),
		).not.toContain("wait_for_process");
		expect(
			createBuiltinTools({ executors: { bash: async () => "remote" } }).map(
				(tool) => tool.name,
			),
		).not.toContain("wait_for_process");
		expect(
			createBuiltinTools({
				executors: {
					bash: async () => "remote",
					processWait: createProcessWaitExecutor(),
				},
			}).map((tool) => tool.name),
		).toContain("wait_for_process");
	});
	it.skipIf(process.platform !== "linux")(
		"waits on a shell-launched background PID without inventing its exit code",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "process-wait-launch-"));
			const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
			try {
				const shell = createShellTool(createShellExecutor(), {
					cwd: directory,
				});
				const launch = await shell.execute(
					{
						commands: [
							`nohup ${quote(process.execPath)} -e "setTimeout(()=>process.exit(7),500)" > run.log 2>&1 < /dev/null & echo $!`,
						],
					},
					context,
				);
				expect(launch[0].success).toBe(true);
				const pid = Number(String(launch[0].result).trim());
				expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
				const wait = createWaitForProcessTool(createProcessWaitExecutor(), {
					cwd: directory,
				});
				let result = (await wait.execute(
					{ pid, log_path: "run.log", wait_seconds: 2 },
					context,
				)) as { state: string; revision: number; exit_code: null };
				for (let i = 0; i < 3 && result.state === "running"; i++)
					result = (await wait.execute(
						{ pid, wait_seconds: 2, after_revision: result.revision },
						context,
					)) as typeof result;
				expect(result).toMatchObject({ state: "exited", exit_code: null });
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
});
