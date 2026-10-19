import { describe, expect, it } from "vitest";
import {
	buildSummaryRequest,
	serializeConversation,
} from "./compaction-shared";

describe("continuation evidence", () => {
	it("summarizes executed outcomes without replaying old scratch plans", () => {
		const text = serializeConversation([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "OBSOLETE PLAN: move the block again" },
					{ type: "text", text: "The block has been moved." },
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "r",
						name: "run_commands",
						content: "exit code 0; placement validated",
					},
				],
			},
		]);
		expect(text).not.toContain("OBSOLETE PLAN");
		expect(text).toContain("The block has been moved.");
		expect(text).toContain("placement validated");
		const request = buildSummaryRequest({
			conversationText: text,
			previousSummary: "Move the block next",
			fileOps: { readFiles: ["API.md"], modifiedFiles: ["API.md"] },
		});
		expect(request).toContain("Reconcile the old summary");
		expect(request).toContain("delivery is next");
	});
});
