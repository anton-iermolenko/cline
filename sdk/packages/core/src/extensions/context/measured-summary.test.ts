import type { MessageWithMetadata } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countUserRunMessages } from "../../session/user-run-messages";
import type { CoreCompactionContext } from "../../types/config";
import { runAgenticCompaction } from "./agentic-compaction";
import { buildSummaryMessage, createTokenEstimator } from "./compaction-shared";
import { summarySections } from "./measured-summary";

const mocks = vi.hoisted(() => ({
	count: vi.fn(),
	generate: vi.fn(),
	configs: [] as Record<string, any>[],
}));
vi.mock("../../services/llms/handler-factory", () => ({
	createAgentModelFromConfig: () => ({ countInputTokens: mocks.count }),
}));
vi.mock("@cline/llms", () => ({
	createHandlerAsync: async (config: Record<string, any>) => {
		mocks.configs.push(config);
		return { createMessage: mocks.generate };
	},
}));
const providerConfig = {
	providerId: "openai-compatible",
	modelId: "local",
	maxOutputTokens: 8192,
	knownModels: {
		local: {
			id: "local",
			contextWindow: 128192,
			maxInputTokens: 120000,
			maxTokens: 8192,
			metadata: { inputTokenCountUrl: "http://localhost/count" },
		},
	},
};
function input(signal = new AbortController().signal) {
	const messages: MessageWithMetadata[] = [
		buildSummaryMessage({
			summary: "Old checkpoint evidence ".repeat(20),
			fileOps: { readFiles: [], modifiedFiles: [] },
			tokensBefore: 100000,
			userRunSpan: 2,
		}),
		{
			id: "first",
			role: "user",
			content: "  Keep the existing API and whitespace.\n",
		},
		...Array.from({ length: 6 }, (_, i) => ({
			id: `step-${i}`,
			role: "assistant" as const,
			content: `BEGIN-${i} ` + "evidence ".repeat(750) + ` END-${i}`,
		})),
		{
			id: "latest",
			role: "user",
			content: "Keep my current instruction verbatim.",
		},
		{ role: "assistant", content: "Latest live response" },
	];
	return {
		context: {
			agentId: "test",
			conversationId: "test",
			parentAgentId: null,
			iteration: 1,
			mode: "auto",
			model: {
				id: "local",
				provider: "openai-compatible",
				info: providerConfig.knownModels.local,
			},
			messages,
			budget: {
				request: {
					inputTokens: 180000,
					maxInputTokens: 120000,
					triggerTokens: 119872,
					targetTokens: 35000,
					summaryTokens: 16000,
					overheadTokens: 1000,
					thresholdRatio: 0.99,
					utilizationRatio: 1.5,
				},
				messages: {
					inputTokens: 179000,
					triggerTokens: 118872,
					targetTokens: 34000,
				},
			},
			abortSignal: signal,
		} satisfies CoreCompactionContext,
		providerConfig,
		preserveRecentTokens: 1,
		estimateMessageTokens: createTokenEstimator(),
	};
}
function count(
	request: { messages: { content: { text: string }[] }[] },
	limit = 120000,
) {
	return {
		inputTokens: request.messages.reduce(
			(sum, message) =>
				sum + message.content.map((part) => part.text).join("").length,
			0,
		),
		maxInputTokens: limit,
	};
}
function factualNotes(label: string): string {
	return (
		`- ${label}\n` +
		Array.from(
			{ length: 14 },
			(_, i) =>
				`- Verified field ${i}: exact request schema, observed success, retained compatibility and pending review.`,
		).join("\n")
	);
}
function generationRequests(): string[] {
	return mocks.generate.mock.calls.map(([, messages]) => messages[0].content);
}
describe("measured summary checkpoints", () => {
	beforeEach(() => {
		mocks.configs.length = 0;
		mocks.count
			.mockReset()
			.mockImplementation(async (request) => count(request));
		let n = 0;
		mocks.generate.mockReset().mockImplementation(async function* () {
			yield {
				type: "text",
				text: factualNotes(`UNIQUE-NOTE-${++n}: confirmed evidence.`),
			};
			yield { type: "done", success: true };
		});
	});
	const source = (request: string) =>
		request.split("<new_messages>\n")[1]?.split("\n</new_messages>")[0];
	it("batches whole new history toward 16K and appends additions to read-only reference notes", async () => {
		const options = input(),
			original = JSON.stringify(options.context.messages);
		const result = await runAgenticCompaction(options),
			requests = generationRequests();
		expect(requests.length).toBeGreaterThan(2);
		for (let i = 0; i < requests.length; i++) {
			expect(source(requests[i])!.length).toBeLessThanOrEqual(16000);
			for (let earlier = 1; earlier <= i; earlier++)
				expect(requests[i]).toContain(`UNIQUE-NOTE-${earlier}:`);
		}
		for (let i = 0; i < 6; i++) {
			const containing = requests.filter((r) =>
				source(r)?.includes(`BEGIN-${i}`),
			);
			expect(containing).toHaveLength(1);
			expect(source(containing[0])).toContain(`END-${i}`);
		}
		expect(result!.messages[0].metadata!.summary).toContain("UNIQUE-NOTE-1");
		expect(JSON.stringify(options.context.messages)).toBe(original);
	});
	it("does not use assistant prefill, including on native vLLM", async () => {
		const options = input();
		options.providerConfig = { ...options.providerConfig, providerId: "vllm" };
		await runAgenticCompaction(options);
		for (const [, messages] of mocks.generate.mock.calls) {
			expect(messages).toHaveLength(1);
			expect(messages[0].role).toBe("user");
			expect(messages[0].content).toContain("<saved_summary>");
		}
		expect(mocks.configs.every((c) => !c.continueAssistantMessage)).toBe(true);
		expect(mocks.configs[0].maxOutputTokens).toBe(5000);
		expect(mocks.configs[0].localInference).toMatchObject({
			temperature: 0.7,
			topP: 0.8,
			topK: 20,
			minP: 0,
			presencePenalty: 1.5,
			repeatPenalty: 1,
			thinking: false,
		});
	});
	it("summarizes older human inputs with their replies and retains only the latest folded instruction", async () => {
		const options = input();
		const first = options.context.messages.find((m) => m.id === "first")!;
		const latest = options.context.messages.find((m) => m.id === "latest")!;
		const result = await runAgenticCompaction(options);
		const sources = generationRequests().map(source).join("\n");
		expect(sources).toContain(first.content);
		expect(sources.indexOf(first.content as string)).toBeLessThan(
			sources.indexOf("BEGIN-0"),
		);
		expect(result!.messages.some((m) => m.id === first.id)).toBe(false);
		expect(result!.messages.filter((m) => m.id === latest.id)).toEqual([
			latest,
		]);
		expect(countUserRunMessages(result!.messages)).toBe(
			countUserRunMessages(options.context.messages),
		);
	});
	it("compacts accumulated large user messages without splitting or reinserting them", async () => {
		const options = input();
		const older = Array.from({ length: 4 }, (_, i) => [
			{
				id: `large-user-${i}`,
				role: "user" as const,
				content:
					`USER-START-${i} ` +
					"attached evidence ".repeat(1300) +
					` USER-END-${i}`,
			},
			{ role: "assistant" as const, content: `REPLY-${i}` },
		]).flat();
		options.context.messages.splice(1, 1, ...older);
		const before = JSON.stringify(options.context.messages);
		const result = await runAgenticCompaction(options);
		const sources = generationRequests().map(source).join("\n");
		for (let i = 0; i < 4; i++) {
			const containing = generationRequests().filter((r) =>
				source(r)?.includes(`USER-START-${i}`),
			);
			expect(containing).toHaveLength(1);
			expect(source(containing[0])).toContain(`USER-END-${i}`);
			expect(sources.indexOf(`USER-END-${i}`)).toBeLessThan(
				sources.indexOf(`REPLY-${i}`),
			);
			expect(result!.messages.some((m) => m.id === `large-user-${i}`)).toBe(
				false,
			);
		}
		expect(result!.messages.filter((m) => m.id === "latest")).toHaveLength(1);
		expect(countUserRunMessages(result!.messages)).toBe(
			countUserRunMessages(options.context.messages),
		);
		expect(JSON.stringify(options.context.messages)).toBe(before);
	});
	it("retains recent user messages in their normal chronological positions", async () => {
		const options = input();
		const recent = {
			id: "recent-user",
			role: "user" as const,
			content: "Recent correction",
		};
		options.context.messages.splice(-2, 0, recent, {
			role: "assistant",
			content: "Recent correction acknowledged",
		});
		options.preserveRecentTokens = 200;
		const result = await runAgenticCompaction(options);
		const recentIndex = result!.messages.indexOf(recent);
		expect(recentIndex).toBeGreaterThan(0);
		expect(result!.messages[recentIndex + 1].content).toBe(
			"Recent correction acknowledged",
		);
		expect(result!.messages[recentIndex + 2].id).toBe("latest");
		expect(result!.messages.filter((m) => m.id === "latest")).toHaveLength(1);
		expect(countUserRunMessages(result!.messages)).toBe(
			countUserRunMessages(options.context.messages),
		);
	});
	it("keeps a full oversized tool exchange intact, including middle evidence", async () => {
		const options = input(),
			output =
				"BEGIN-TOOL " +
				"a".repeat(18000) +
				"CRITICAL-MIDDLE-CONTRACT" +
				"z".repeat(18000) +
				" END-TOOL";
		options.context.messages.splice(
			2,
			0,
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "read-1",
						name: "read_files",
						input: { path: "contract.ts" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "read-1",
						name: "read_files",
						content: [{ type: "text", text: output }],
					},
				],
			},
		);
		await runAgenticCompaction(options);
		const requests = generationRequests().filter((r) =>
			source(r)?.includes("BEGIN-TOOL"),
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(output);
		expect(requests[0]).toContain("[Bot tool calls]: read_files");
	});
	it("rejects an indivisible exchange above the real allowance without modifying history", async () => {
		const options = input();
		options.context.messages[2].content = "x".repeat(130000);
		const original = JSON.stringify(options.context.messages);
		await expect(runAgenticCompaction(options)).rejects.toThrow(
			"intact message/tool exchange",
		);
		expect(JSON.stringify(options.context.messages)).toBe(original);
		expect(
			generationRequests().every((r) => !r.includes("x".repeat(1000))),
		).toBe(true);
	});
	it("retries a truncated primary with smaller intact source and a lower target", async () => {
		let n = 0;
		mocks.generate.mockImplementation(async function* () {
			if (++n === 1) {
				yield { type: "text", text: "Partial" };
				yield {
					type: "done",
					success: true,
					incompleteReason: "max_output_tokens",
				};
			} else {
				yield { type: "text", text: factualNotes(`BACKUP-${n}`) };
				yield { type: "done", success: true };
			}
		});
		await runAgenticCompaction(input());
		const requests = generationRequests();
		expect(requests[0]).toContain("1200 words");
		expect(requests[1]).toContain("600 words");
		const first = source(requests[0])!;
		let rebuilt = "",
			i = 1;
		while (rebuilt.length < first.length) {
			rebuilt += (rebuilt ? "\n\n" : "") + source(requests[i++]);
			expect(mocks.configs[i - 1].maxOutputTokens).toBe(4000);
		}
		expect(rebuilt).toBe(first);
	});
	it("rejects the whole operation when the second backup fails", async () => {
		let n = 0;
		mocks.generate.mockImplementation(async function* () {
			n++;
			yield {
				type: "text",
				text: n === 2 ? factualNotes("Valid first backup") : "Partial",
			};
			yield {
				type: "done",
				success: true,
				incompleteReason: n === 2 ? undefined : "max_output_tokens",
			};
		});
		const options = input(),
			original = JSON.stringify(options.context.messages);
		await expect(runAgenticCompaction(options)).rejects.toThrow(
			"empty or incomplete",
		);
		expect(mocks.generate).toHaveBeenCalledTimes(3);
		expect(JSON.stringify(options.context.messages)).toBe(original);
	});
	it.each([
		"empty",
		"incomplete",
		"tiny",
	])("preserves history after a bounded %s failure", async (failure) => {
		mocks.generate.mockImplementation(async function* () {
			yield {
				type: "text",
				text: failure === "empty" ? "" : "- Tiny next step.",
			};
			yield {
				type: "done",
				success: true,
				incompleteReason:
					failure === "incomplete" ? "max_output_tokens" : undefined,
			};
		});
		const options = input();
		options.context.messages = [
			{
				role: "assistant",
				content: "A large intact record " + "x".repeat(20000),
			},
			{ role: "assistant", content: "Recent" },
		];
		const original = JSON.stringify(options.context.messages);
		await expect(runAgenticCompaction(options)).rejects.toThrow(
			failure === "tiny" ? "usable factual notes" : "empty or incomplete",
		);
		expect(mocks.generate).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(options.context.messages)).toBe(original);
	});
	it("keeps a short legitimate factual correction", async () => {
		mocks.generate.mockImplementation(async function* () {
			yield {
				type: "text",
				text: "- Correction: deployment completed; no restart remains.",
			};
			yield { type: "done", success: true };
		});
		const options = input();
		options.context.messages = [
			options.context.messages[0],
			{ role: "assistant", content: "Deployment exit 0." },
			{ role: "assistant", content: "Recent" },
		];
		const result = await runAgenticCompaction(options);
		expect(result!.messages[0].metadata!.summary).toContain(
			"deployment completed",
		);
	});
	it("keeps prior checkpoints verbatim below quota across repeated compactions", async () => {
		const options = input();
		let previous = "Old checkpoint retained verbatim.";
		for (let round = 0; round < 3; round++) {
			options.context.messages = [
				buildSummaryMessage({
					summary: previous,
					fileOps: { readFiles: [], modifiedFiles: [] },
					tokensBefore: 10000,
					userRunSpan: 1,
				}),
				{ role: "assistant", content: `Completed step ${round}.` },
				{ role: "assistant", content: "Recent" },
			];
			const result = await runAgenticCompaction(options);
			const next = result!.messages[0].metadata!.summary as string;
			expect(next.startsWith(previous)).toBe(true);
			previous = next;
		}
	});
	it("reduces oldest adjacent notes only when over quota and keeps newer notes unchanged", async () => {
		mocks.generate.mockImplementation(async function* (_system, messages) {
			const request = messages[0].content;
			yield {
				type: "text",
				text: request.startsWith("Merge these adjacent")
					? "- MERGED old facts " + "m".repeat(850)
					: "- NEWEST evidence " +
						"n".repeat(1800) +
						"\n\n- NEWEST detail\n  - nested detail",
			};
			yield { type: "done", success: true };
		});
		const options = input();
		const old = Array.from(
			{ length: 6 },
			(_, i) => `- OLD-${i} ` + "x".repeat(1300),
		).join("\n\n");
		options.context.messages = [
			buildSummaryMessage({
				summary: old,
				fileOps: { readFiles: [], modifiedFiles: [] },
				tokensBefore: 20000,
				userRunSpan: 1,
			}),
			{ role: "assistant", content: "New completed work." },
			{ role: "assistant", content: "Recent" },
		];
		options.context.budget.request.summaryTokens = 4000;
		const result = await runAgenticCompaction(options),
			edits = generationRequests().filter((r) =>
				r.startsWith("Merge these adjacent"),
			);
		expect(edits.length).toBeGreaterThan(0);
		expect(edits[0]).toContain("OLD-0");
		expect(edits[0]).not.toContain("NEWEST evidence");
		const final = result!.messages[0].metadata!.summary as string;
		expect(final).toContain(
			"- NEWEST evidence " +
				"n".repeat(1800) +
				"\n\n- NEWEST detail\n  - nested detail",
		);
		expect(final.length).toBeLessThan(4000);
	});
	it("rejects non-shrinking pair reductions rather than looping or discarding context", async () => {
		mocks.generate.mockImplementation(async function* (_system, messages) {
			const request = messages[0].content;
			yield {
				type: "text",
				text: request.startsWith("Merge these adjacent")
					? request.split("<source_notes>\n")[1].split("\n</source_notes>")[0]
					: factualNotes("NEW"),
			};
			yield { type: "done", success: true };
		});
		const options = input();
		options.context.budget.request.summaryTokens = 2000;
		const original = JSON.stringify(options.context.messages);
		await expect(runAgenticCompaction(options)).rejects.toThrow(
			/did not shrink|token quota/,
		);
		expect(JSON.stringify(options.context.messages)).toBe(original);
	});
	it("does not split nested bullets or fenced code while partitioning summaries", () => {
		const text =
			"- Parent\n  - child\n```ts\n- code, not a note\n```\n\n- Second\n";
		const parts = summarySections(text);
		expect(parts).toHaveLength(2);
		expect(parts.join("")).toBe(text);
		expect(parts[0]).toContain("- code, not a note");
	});
	it("does not generate after cancellation during counting", async () => {
		const abort = new AbortController();
		mocks.count.mockImplementation(async (request) => {
			abort.abort();
			return count(request);
		});
		await expect(
			runAgenticCompaction(input(abort.signal)),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(mocks.generate).not.toHaveBeenCalled();
	});
	it("does not retry after cancellation during generation", async () => {
		const abort = new AbortController();
		mocks.generate.mockImplementation(async function* () {
			yield { type: "text", text: "" };
			abort.abort();
			yield { type: "done", success: true };
		});
		await expect(
			runAgenticCompaction(input(abort.signal)),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});
	it("rejects changing or unavailable native input limits", async () => {
		let n = 0;
		mocks.count.mockImplementation(async (request) =>
			count(request, ++n === 1 ? 120000 : 100000),
		);
		await expect(runAgenticCompaction(input())).rejects.toThrow(
			"input allowance changed",
		);
		expect(mocks.generate).not.toHaveBeenCalled();
		mocks.count.mockResolvedValue(undefined);
		await expect(runAgenticCompaction(input())).rejects.toThrow(
			"counting unavailable",
		);
	});
});

it("reserves recent history using the actual full-request cost before summarizing", async () => {
	mocks.count.mockReset().mockImplementation(async (request) => count(request));
	mocks.generate.mockReset().mockImplementation(async function* () {
		yield { type: "text", text: factualNotes("Measured retained evidence") };
		yield { type: "done", success: true };
	});
	const options = input();
	options.preserveRecentTokens = 20000;
	options.context.budget.request.targetTokens = 15000;
	options.context.budget.request.summaryTokens = 4000;
	options.context.budget.messages.targetTokens = 14000;
	const measure = async (messages: MessageWithMetadata[]) => ({
		inputTokens:
			500 +
			messages.reduce(
				(n, m) =>
					n +
					(typeof m.content === "string"
						? m.content.length
						: m.content
								.filter((b) => b.type === "text")
								.map((b) => b.text)
								.join("").length),
				0,
			),
		maxInputTokens: 120000,
	});
	const result = await runAgenticCompaction({
		...options,
		context: { ...options.context, countRequestInputTokens: measure },
	});
	expect((await measure(result!.messages)).inputTokens).toBeLessThanOrEqual(
		15000,
	);
	expect(result!.messages.some((m) => m.id === "latest")).toBe(true);
});

it("checks reduction across the combined backup, allowing a small piece to grow within headroom", async () => {
	mocks.count.mockReset().mockImplementation(async (request) => count(request));
	let failed = false;
	const expanded: boolean[] = [];
	mocks.generate
		.mockReset()
		.mockImplementation(async function* (_system, messages) {
			const request = messages[0].content as string;
			if (request.startsWith("Merge these adjacent")) {
				const body = request
					.split("<source_notes>\n")[1]
					.split("\n</source_notes>")[0];
				if (!failed) {
					failed = true;
					yield { type: "text", text: "Partial" };
					yield {
						type: "done",
						success: true,
						incompleteReason: "max_output_tokens",
					};
					return;
				}
				const size =
					request.includes("600 words") && body.length < 1600 ? 1600 : 1000;
				if (request.includes("600 words")) expanded.push(size > body.length);
				yield {
					type: "text",
					text: "- Condensed verified findings " + "x".repeat(size),
				};
			} else yield { type: "text", text: factualNotes("New completed work") };
			yield { type: "done", success: true };
		});
	const options = input();
	options.context.budget.request.summaryTokens = 4000;
	options.context.messages = [
		buildSummaryMessage({
			summary: Array.from(
				{ length: 8 },
				(_, i) => `- Old note ${i} ` + "a".repeat(650),
			).join("\n\n"),
			fileOps: { readFiles: [], modifiedFiles: [] },
			tokensBefore: 20000,
			userRunSpan: 1,
		}),
		{ role: "assistant", content: "A completed step." },
		{ role: "assistant", content: "Recent" },
	];
	const result = await runAgenticCompaction(options);
	expect(expanded).toContain(true);
	expect((result!.messages[0].metadata!.summary as string).length).toBeLessThan(
		4000,
	);
});

it("keeps an outer four-backtick fence intact around nested three-backtick examples", () => {
	const text = "- Parent\n````md\n```ts\n- Inside code\n```\n````\n\n- Next\n";
	const sections = summarySections(text);
	expect(sections).toHaveLength(2);
	expect(sections.join("")).toBe(text);
	expect(sections[0]).toContain("- Inside code");
});
