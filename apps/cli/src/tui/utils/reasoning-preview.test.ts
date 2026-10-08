import { afterEach, describe, expect, it, vi } from "vitest";
import {
	REASONING_PREVIEW_MAX_CHARS,
	ReasoningStreamBuffer,
	reasoningPreview,
} from "./reasoning-preview";

afterEach(() => vi.useRealTimers());

describe("reasoning preview", () => {
	it("bounds both many short lines and a single huge line", () => {
		expect(
			reasoningPreview(
				Array.from({ length: 10000 }, (_, i) => `line ${i}`).join("\n"),
			).split("\n"),
		).toHaveLength(8);
		expect(reasoningPreview("a".repeat(1_000_000))).toHaveLength(
			REASONING_PREVIEW_MAX_CHARS,
		);
	});
	it("batches thousands of chunks and preserves the complete text on finish", () => {
		vi.useFakeTimers();
		const publish = vi.fn();
		const buffer = new ReasoningStreamBuffer(publish);
		const chunks = [
			"first\n",
			...Array.from({ length: 10000 }, (_, i) => `chunk ${i}\n`),
		];
		buffer.start(chunks[0]);
		for (const chunk of chunks.slice(1)) buffer.append(chunk);
		expect(publish).not.toHaveBeenCalled();
		vi.advanceTimersByTime(99);
		expect(publish).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(publish).toHaveBeenCalledOnce();
		expect(publish.mock.calls[0][0]).toBe(reasoningPreview(chunks.join("")));
		expect(buffer.finish()).toBe(chunks.join(""));
		vi.runAllTimers();
		expect(publish).toHaveBeenCalledOnce();
	});
	it("finishes pending chunks before a timer fires and cancels stale updates", () => {
		vi.useFakeTimers();
		const publish = vi.fn();
		const buffer = new ReasoningStreamBuffer(publish);
		buffer.start("first");
		buffer.append(" last");
		expect(buffer.finish()).toBe("first last");
		expect(buffer.finish()).toBeUndefined();
		vi.runAllTimers();
		expect(publish).not.toHaveBeenCalled();
		buffer.start("next");
		buffer.append(" block");
		buffer.dispose();
		vi.runAllTimers();
		expect(publish).not.toHaveBeenCalled();
	});
	it("does not let a previous stream timer affect a replacement stream", () => {
		vi.useFakeTimers();
		const publish = vi.fn();
		const buffer = new ReasoningStreamBuffer(publish);
		buffer.start("old");
		buffer.append(" discarded");
		expect(buffer.start("new")).toBe("new");
		buffer.append(" stream");
		vi.advanceTimersByTime(100);
		expect(publish.mock.calls).toEqual([["new stream"]]);
		expect(buffer.finish()).toBe("new stream");
	});
});
