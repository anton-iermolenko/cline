import type { AgentTool, AgentToolContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createBackgroundCommandTools } from "./background-job-tools";
import { BackgroundCommandJobs } from "./background-jobs";
import { createShellExecutor } from "./executors/bash";
import { createBuiltinTools } from "./index";

const context: AgentToolContext = {
	agentId: "a",
	sessionId: "session",
	iteration: 1,
};
function nodeCommand(script: string) {
	const executable =
		process.platform === "win32"
			? `& '${process.execPath.replace(/'/g, "''")}'`
			: `'${process.execPath.replace(/'/g, "'\\''")}'`;
	return `${executable} -e "${script}"`;
}
async function terminal(wait: AgentTool, jobId: string) {
	let after_revision: number | undefined;
	for (let i = 0; i < 6; i++) {
		const result = (await wait.execute(
			{ job_id: jobId, wait_seconds: 2, after_revision },
			context,
		)) as { state: string; revision: number };
		if (result.state !== "running") return result;
		after_revision = result.revision;
	}
	throw new Error("Command did not finish within the test's bounded waits");
}
function fixture() {
	const tools = createBackgroundCommandTools(
		createShellExecutor({ timeoutMs: 5000 }),
		{ jobs: new BackgroundCommandJobs() },
	);
	return { start: tools[0], wait: tools[1], cancel: tools[2] };
}
describe("managed background commands", () => {
	it("enforces the command execution deadline independently of waiting", async () => {
		const tools = createBackgroundCommandTools(
			createShellExecutor({ timeoutMs: 5000 }),
			{ jobs: new BackgroundCommandJobs(), timeoutMs: 40 },
		);
		const job = (await tools[0].execute(
			{ command: nodeCommand("setTimeout(()=>{},8000)") },
			context,
		)) as { job_id: string };
		expect(await terminal(tools[1], job.job_id)).toMatchObject({
			state: "failed",
			command_error: expect.stringContaining("execution deadline"),
		});
	});
	it("preserves job ownership across toolset rebuilds in the same hub", async () => {
		const executor = createShellExecutor({ timeoutMs: 5000 });
		const first = createBackgroundCommandTools(executor);
		const job = (await first[0].execute(
			{ command: nodeCommand("setTimeout(()=>{},8000)") },
			context,
		)) as { job_id: string };
		const second = createBackgroundCommandTools(executor);
		expect(
			await second[1].execute({ job_id: job.job_id, wait_seconds: 0 }, context),
		).toMatchObject({ state: "running" });
		await second[2].execute({ job_id: job.job_id }, context);
		expect(await terminal(second[1], job.job_id)).toMatchObject({
			state: "cancelled",
		});
	});
	it("captures real command output and exit status after returning a job ID", async () => {
		const { start, wait } = fixture();
		const job = (await start.execute(
			{
				command: nodeCommand("setTimeout(()=>console.log('finished'),100)"),
			},
			context,
		)) as { job_id: string };
		const done = await terminal(wait, job.job_id);
		expect(done).toMatchObject({
			state: "completed",
			exit_code: 0,
			output: expect.stringContaining("finished"),
		});
	});
	it("reports a nonzero command exit as a job outcome, not an inspection error", async () => {
		const { start, wait } = fixture();
		const job = (await start.execute(
			{
				command: nodeCommand("console.error('bad');process.exit(7)"),
			},
			context,
		)) as { job_id: string };
		expect(await terminal(wait, job.job_id)).toMatchObject({
			state: "failed",
			exit_code: 7,
			output: expect.stringContaining("bad"),
		});
	});
	it("cancelling a wait leaves the command running; cancelling the job terminates it", async () => {
		const { start, wait, cancel } = fixture();
		const job = (await start.execute(
			{ command: nodeCommand("setTimeout(()=>{},8000)") },
			context,
		)) as { job_id: string };
		const controller = new AbortController();
		const pending = wait.execute(
			{ job_id: job.job_id, wait_seconds: 2 },
			{ ...context, signal: controller.signal },
		);
		controller.abort(new Error("cancel wait"));
		await expect(pending).rejects.toThrow("cancel wait");
		expect(
			await wait.execute({ job_id: job.job_id, wait_seconds: 0 }, context),
		).toMatchObject({ state: "running" });
		await cancel.execute({ job_id: job.job_id }, context);
		expect(
			await wait.execute({ job_id: job.job_id, wait_seconds: 2 }, context),
		).toMatchObject({ state: "cancelled" });
	});
	it("rejects unknown/cross-session jobs and malformed arguments", async () => {
		const { start, wait, cancel } = fixture();
		const job = (await start.execute(
			{ command: nodeCommand("setTimeout(()=>{},8000)") },
			context,
		)) as { job_id: string };
		try {
			await expect(
				wait.execute(
					{ job_id: job.job_id, wait_seconds: 0 },
					{ ...context, sessionId: "other" },
				),
			).rejects.toThrow("Unknown background job");
			await expect(
				cancel.execute(
					{ job_id: job.job_id },
					{ ...context, sessionId: "other" },
				),
			).rejects.toThrow("Unknown background job");
			await expect(
				wait.execute({ job_id: "missing", wait_seconds: 0 }, context),
			).rejects.toThrow("Unknown background job");
			await expect(
				wait.execute({ job_id: job.job_id, wait_seconds: 61 }, context),
			).rejects.toThrow();
			await expect(
				start.execute({ command: "", polling: true }, context),
			).rejects.toThrow();
		} finally {
			await cancel.execute({ job_id: job.job_id }, context);
			await wait.execute({ job_id: job.job_id, wait_seconds: 2 }, context);
		}
	});
	it("keeps quiet jobs running across unchanged successful waits", async () => {
		const { start, wait, cancel } = fixture();
		const job = (await start.execute(
			{ command: nodeCommand("setTimeout(()=>{},8000)") },
			context,
		)) as { job_id: string };
		try {
			const result = await wait.execute(
				{ job_id: job.job_id, wait_seconds: 1, after_revision: 0 },
				context,
			);
			expect(result).toMatchObject({
				state: "running",
				revision: 0,
				changed: false,
			});
			expect(result).not.toHaveProperty("output");
		} finally {
			await cancel.execute({ job_id: job.job_id }, context);
			await wait.execute({ job_id: job.job_id, wait_seconds: 2 }, context);
		}
	});
	it("does not bypass a custom host executor and follows the shell toggle", () => {
		expect(
			createBuiltinTools({ enableBash: false }).map((t) => t.name),
		).not.toContain("start_background_command");
		expect(
			createBuiltinTools({ executors: { bash: async () => "sandboxed" } }).map(
				(t) => t.name,
			),
		).not.toContain("start_background_command");
		expect(
			createBuiltinTools({
				executors: {
					bash: async () => "sandboxed",
					backgroundBash: async () => "sandboxed",
				},
			}).map((t) => t.name),
		).toContain("start_background_command");
	});
});
