import { describe, expect, it } from "vitest";
import { LoopDetectionTracker } from "./loop-detection";

const job_id = "4e38a35c-31b6-4f7d-833b-7a45a08528cc";

describe("tool names never exempt repeated calls", () => {
	it.each([
		"consult-expert__expert_status",
		"wait_for_job",
		"run_commands",
	])("retains detection without runtime validation: %s", (name) => {
		const tracker = new LoopDetectionTracker();
		for (let i = 0; i < 4; i++)
			tracker.inspect({ name, input: { job_id, wait_seconds: 60 } });
		expect(
			tracker.inspect({ name, input: { job_id, wait_seconds: 60 } }).kind,
		).toBe("hard");
	});
});

describe("rolling unchanged observations", () => {
	const read = (path: string, start = 1) => ({
		name: "read_files",
		input: { files: [{ path, start_line: start }] },
	});
	const result = (text: string) => [
		{ query: "variable range label", result: text, success: true },
	];
	it("detects alternating reads but allows different pages and changed evidence", () => {
		const t = new LoopDetectionTracker();
		for (let i = 0; i < 2; i++) {
			expect(t.observeResult(read("a"), result("same")).kind).toBe("ok");
			t.observeResult(read("b"), result("other"));
		}
		expect(t.observeResult(read("a", 4), result("same")).kind).toBe("soft");
		expect(t.observeResult(read("a", 9), result("new page")).kind).toBe("ok");
		expect(t.observeResult(read("a", 10), result("new page")).kind).toBe("ok");
	});
	it("stops persistent unchanged inspections at the hard threshold", () => {
		const t = new LoopDetectionTracker();
		for (let i = 0; i < 4; i++) {
			t.observeResult(read("a"), "same");
			t.observeResult(read("b"), "other");
		}
		expect(t.observeResult(read("a"), "same").kind).toBe("hard");
	});
	it.each([
		"edit_file",
		"run_commands",
		"consult-expert__expert_status",
	])("resets after a possible mutation, unknown command, or blocking wait: %s", (name) => {
		const t = new LoopDetectionTracker();
		t.observeResult(read("a"), "same");
		t.observeResult(read("a"), "same");
		t.observeResult(
			{
				name,
				input: { commands: ["python3 update.py"], job_id, wait_seconds: 60 },
			},
			"done",
		);
		expect(t.observeResult(read("a"), "same").kind).toBe("ok");
	});
	it("uses the same configurable thresholds and resets on an error", () => {
		const t = new LoopDetectionTracker({ softThreshold: 2, hardThreshold: 4 });
		t.observeResult(read("a"), "same");
		expect(t.observeResult(read("a"), "same").kind).toBe("soft");
		t.observeResult(read("a"), "failure", true);
		expect(t.observeResult(read("a"), "same").kind).toBe("ok");
		t.reset();
		expect(t.observeResult(read("a"), "same").kind).toBe("ok");
	});
});
