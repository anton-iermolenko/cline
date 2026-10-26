import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	createJobWaitCapability,
	parseJobWaitObservation,
	parseJobWaitRequest,
	waitForJobStatus,
} from "./job-wait";
import { JobWaitTracker } from "./job-wait-tracker";

const running = { job_id: "job", state: "running", revision: 4 };
describe("bounded job waits", () => {
	it("allows quiet running timeouts and returns the last snapshot", async () => {
		const started = performance.now();
		const result = await waitForJobStatus({
			request: { jobId: "job", waitMs: 35 },
			read: async () => running,
			observe: parseJobWaitObservation,
		});
		expect(result).toBe(running);
		expect(performance.now() - started).toBeGreaterThanOrEqual(30);
	});
	it("returns completion, failure, cancellation, and human questions immediately", async () => {
		for (const state of [
			"completed",
			"failed",
			"cancelled",
			"waiting_for_input",
		]) {
			const output = { ...running, state, error: "optional failure details" };
			expect(
				await waitForJobStatus({
					request: { jobId: "job", waitMs: 60_000 },
					read: async () => output,
					observe: parseJobWaitObservation,
				}),
			).toBe(output);
		}
	});
	it("wakes on a newer revision and keeps wait_seconds=0 as an immediate snapshot", async () => {
		expect(
			await waitForJobStatus({
				request: { jobId: "job", waitMs: 60_000, afterRevision: 3 },
				read: async () => running,
				observe: parseJobWaitObservation,
			}),
		).toBe(running);
		expect(
			await waitForJobStatus({
				request: { jobId: "job", waitMs: 0 },
				read: async () => running,
				observe: parseJobWaitObservation,
			}),
		).toBe(running);
	});
	it("cancels a quiet wait and passes a cancellable signal to adapters", async () => {
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		const promise = waitForJobStatus({
			request: { jobId: "job", waitMs: 60_000 },
			signal: controller.signal,
			read: async (_remaining, signal) => {
				received = signal;
				return running;
			},
			observe: parseJobWaitObservation,
		});
		controller.abort(new Error("cancel wait"));
		await expect(promise).rejects.toThrow("cancel wait");
		expect(received?.aborted).toBe(true);
	});
	it("returns malformed and mismatched responses without manufacturing a valid job", async () => {
		for (const output of [
			{ error: "missing job" },
			{ ...running, job_id: "other" },
			{ ...running, revision: -1 },
		]) {
			expect(
				await waitForJobStatus({
					request: { jobId: "job", waitMs: 60_000 },
					read: async () => output,
					observe: parseJobWaitObservation,
				}),
			).toBe(output);
		}
	});
	it.each([
		{},
		{ job_id: "" },
		{ job_id: "job", wait_seconds: "60" },
		{ job_id: "job", wait_seconds: 61 },
		{ job_id: "job", wait_seconds: -1 },
		{ job_id: "job", after_revision: -1 },
		{ job_id: "job", polling: true },
	])("rejects invalid/claimed polling inputs: %j", (input) => {
		expect(parseJobWaitRequest(input)).toBeUndefined();
	});
});

describe("verified wait accounting", () => {
	const tool = {
		name: "wait",
		waiting: createJobWaitCapability(),
	} as AgentTool;
	it("accepts many quiet actual waits of different lengths", () => {
		const tracker = new JobWaitTracker();
		for (const waitMs of [1000, 20_000, 60_000, 30_000, 26_000, 1000, 60_000]) {
			expect(
				tracker.inspect(
					tool,
					{ jobId: "job", waitMs, afterRevision: 4 },
					running,
					waitMs,
				),
			).toBe("valid");
		}
	});
	it("checks job identity, monotonic revisions, and actual elapsed time", () => {
		const tracker = new JobWaitTracker();
		const request = { jobId: "job", waitMs: 60_000, afterRevision: 4 };
		expect(tracker.inspect(tool, request, running, 2)).toBe("invalid");
		expect(tracker.inspect(tool, request, { ...running, revision: 5 }, 2)).toBe(
			"valid",
		);
		expect(tracker.inspect(tool, request, { ...running, revision: 5 }, 2)).toBe(
			"invalid",
		);
		expect(
			tracker.inspect(tool, request, { ...running, revision: 3 }, 60_000),
		).toBe("invalid");
		expect(
			tracker.inspect(tool, request, { ...running, job_id: "other" }, 60_000),
		).toBe("invalid");
	});
	it("uses a separate deadline and does not exempt repeated terminal snapshots", () => {
		const tracker = new JobWaitTracker();
		const bounded = {
			...tool,
			waiting: createJobWaitCapability({ maxWaitMs: 20 }),
		};
		expect(
			tracker.inspect(bounded, { jobId: "job", waitMs: 30 }, running, 30),
		).toBe("deadline");
		const complete = { ...running, state: "completed" };
		expect(
			tracker.inspect(tool, { jobId: "job", waitMs: 30 }, complete, 0),
		).toBe("valid");
		expect(
			tracker.inspect(tool, { jobId: "job", waitMs: 30 }, complete, 0),
		).toBe("invalid");
		tracker.reset();
		expect(
			tracker.inspect(tool, { jobId: "job", waitMs: 30 }, running, 30),
		).toBe("valid");
	});
});
