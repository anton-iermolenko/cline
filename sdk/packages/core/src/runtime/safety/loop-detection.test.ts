import { describe, expect, it } from "vitest";
import { LoopDetectionTracker } from "./loop-detection";

const job_id = "4e38a35c-31b6-4f7d-833b-7a45a08528cc";
const name = "consult-expert__expert_status";

describe("blocking expert waits", () => {
	it.each([undefined, 30, 60])("allows unchanged waits with wait_seconds=%s", (wait_seconds) => {
		const tracker = new LoopDetectionTracker();
		const input = { job_id, after_revision: 19, ...(wait_seconds === undefined ? {} : { wait_seconds }) };
		for (let i = 0; i < 20; i++) {
			expect(tracker.inspect({ name, input })).toEqual({ kind: "ok" });
		}
	});

	it.each([
		{},
		{ job_id, wait_seconds: 0 },
		{ job_id, wait_seconds: 1 },
		{ job_id, wait_seconds: 29 },
		{ job_id, wait_seconds: 61 },
		{ job_id, wait_seconds: "60" },
		{ job_id, wait_seconds: null },
		{ job_id, wait_seconds: 30.5 },
		{ job_id: "", wait_seconds: 60 },
		{ job_id, wait_seconds: 60, after_revision: -1 },
		{ job_id, wait_seconds: 60, unexpected: true },
	])("retains loop detection for nonblocking or invalid calls: %j", (input) => {
		const tracker = new LoopDetectionTracker();
		for (let i = 0; i < 4; i++) tracker.inspect({ name, input });
		expect(tracker.inspect({ name, input }).kind).toBe("hard");
	});

	it.each(["execute_command", "other__expert_status", "consult-expert__consult_expert"])(
		"retains loop detection for %s", (toolName) => {
			const tracker = new LoopDetectionTracker();
			const input = { job_id, wait_seconds: 60 };
			for (let i = 0; i < 4; i++) tracker.inspect({ name: toolName, input });
			expect(tracker.inspect({ name: toolName, input }).kind).toBe("hard");
		},
	);

	it("a blocking wait breaks consecutive calls to another tool", () => {
		const tracker = new LoopDetectionTracker();
		const command = { name: "execute_command", input: { command: "echo test" } };
		tracker.inspect(command);
		tracker.inspect(command);
		tracker.inspect({ name, input: { job_id, wait_seconds: 60 } });
		expect(tracker.inspect(command)).toEqual({ kind: "ok" });
	});
});
