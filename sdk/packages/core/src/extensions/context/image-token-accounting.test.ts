import type {
	MessageWithMetadata,
	RequestInputTokenCount,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createTokenEstimator } from "./compaction-shared";
import { createMeasuredImageTokenEstimator } from "./image-token-accounting";

const message = (content: unknown): MessageWithMetadata =>
	({ role: "user", content }) as MessageWithMetadata;
const measurement = (inputTokens: number): RequestInputTokenCount => ({
	inputTokens,
	source: "tokenized",
	fingerprint: "input",
	budgetRevision: "same-model-budget",
	contextWindow: 81920,
	maxInputTokens: 73727,
	maxOutputTokens: 8192,
	compactionBufferTokens: 2048,
	serverBoundaryTokens: 1,
});
function input(messages: MessageWithMetadata[], tokens = 60000) {
	return {
		messages,
		apiMessages: messages,
		systemPrompt: "System",
		tools: [],
		measurement: measurement(tokens),
		baseEstimateMessageTokens: createTokenEstimator(),
		signal: new AbortController().signal,
	};
}
const image = (data: string) => ({
	type: "image",
	data,
	media_type: "image/jpeg",
});

describe("measured image retention accounting", () => {
	it("uses native vision cost instead of base64 length and keeps the image bytes intact", async () => {
		const plain = message("Earlier work ".repeat(10000));
		async function estimate(data: string) {
			const picture = message([
				{
					type: "tool_result",
					tool_use_id: "read-image",
					content: [image(data), { type: "text", text: "Screenshot" }],
				},
			]);
			const options = input([plain, picture]);
			const original = JSON.stringify(options.messages);
			const countRequest = vi.fn(async (messages: MessageWithMetadata[]) => {
				expect(JSON.stringify(messages)).not.toContain(data);
				return measurement(58000);
			});
			const estimator = await createMeasuredImageTokenEstimator({
				...options,
				countRequest,
			});
			expect(countRequest).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(options.messages)).toBe(original);
			expect(estimator).toBeDefined();
			const text = message([
				{
					type: "tool_result",
					tool_use_id: "read-image",
					content: [{ type: "text", text: "Screenshot" }],
				},
			]);
			expect(estimator!(picture) - estimator!(text)).toBeCloseTo(2000, 0);
			// The API builder can move the same image out of a tool result.
			const apiImage = message([
				{
					type: "image_url",
					image_url: { url: "data:image/jpeg;base64," + data },
				},
			]);
			expect(estimator!(apiImage) - estimator!(message([]))).toBeCloseTo(
				2000,
				0,
			);
			return estimator!(picture);
		}
		expect(await estimate("a".repeat(240000))).toBe(
			await estimate("b".repeat(600000)),
		);
	});

	it("accounts for repeated and different images using native marginal costs", async () => {
		const a = image("first-image");
		const b = image("second-image");
		const pictures = message([a, a, b]);
		const options = input(
			[message("Earlier work ".repeat(2000)), pictures],
			11000,
		);
		const countRequest = vi.fn(async (messages: MessageWithMetadata[]) => {
			const blocks = messages.flatMap((m) =>
				Array.isArray(m.content) ? m.content : [],
			);
			const tokens = blocks.reduce((sum, block) => {
				const data = (block as unknown as { data?: string }).data;
				return (
					sum +
					(data === "first-image" ? 1000 : data === "second-image" ? 2000 : 0)
				);
			}, 7000);
			return measurement(tokens);
		});
		const estimator = await createMeasuredImageTokenEstimator({
			...options,
			countRequest,
		});
		expect(countRequest).toHaveBeenCalledTimes(3);
		expect(estimator!(message([a])) - estimator!(message([]))).toBeCloseTo(
			1000,
			0,
		);
		expect(estimator!(message([b])) - estimator!(message([]))).toBeCloseTo(
			2000,
			0,
		);
		expect(estimator!(pictures) - estimator!(message([]))).toBeCloseTo(4000, 0);
	});

	it("does not probe ordinary file text or conversations without images", async () => {
		const countRequest = vi.fn();
		expect(
			await createMeasuredImageTokenEstimator({
				...input([message("long base64-looking file text ".repeat(1000))]),
				countRequest,
			}),
		).toBeUndefined();
		expect(countRequest).not.toHaveBeenCalled();
	});

	it("preserves context when the counter disappears or changes its budget", async () => {
		const options = input([message([image("data")])]);
		const original = JSON.stringify(options.messages);
		await expect(
			createMeasuredImageTokenEstimator({
				...options,
				countRequest: async () => undefined,
			}),
		).rejects.toThrow("lost its native counter or model budget");
		await expect(
			createMeasuredImageTokenEstimator({
				...options,
				countRequest: async () => ({
					...measurement(58000),
					budgetRevision: "changed",
				}),
			}),
		).rejects.toThrow("lost its native counter or model budget");
		expect(JSON.stringify(options.messages)).toBe(original);
	});

	it("stops after cancellation during calibration", async () => {
		const abort = new AbortController();
		const countRequest = vi.fn(async () => {
			abort.abort();
			return measurement(58000);
		});
		await expect(
			createMeasuredImageTokenEstimator({
				...input([message([image("data")])]),
				signal: abort.signal,
				countRequest,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(countRequest).toHaveBeenCalledTimes(1);
	});
});
