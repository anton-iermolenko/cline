import { describe, expect, it } from "vitest";
import {
	LocalInferenceSettingsSchema,
	localInferenceUserOverrides,
} from "./local-inference";
import {
	resolveAutoCompactionTargetTokens,
	resolveLocalInferenceInputTokens,
} from "./local-model-budget";

describe("local model input and compaction budgets", () => {
	it("reserves total output once and accounts for the native boundary", () => {
		expect(
			resolveLocalInferenceInputTokens({
				contextWindow: 131072,
				maxOutputTokens: 8192,
				nativeCounting: true,
			}),
		).toBe(122879);
		expect(
			resolveLocalInferenceInputTokens({
				contextWindow: 131072,
				maxOutputTokens: 8192,
				nativeCounting: false,
			}),
		).toBe(122880);
	});
	it("never lets a manual cap exceed the remaining context and follows output changes", () => {
		expect(
			resolveLocalInferenceInputTokens({
				contextWindow: 100,
				maxOutputTokens: 20,
				maxInputTokens: 90,
				nativeCounting: true,
			}),
		).toBe(79);
		expect(
			resolveLocalInferenceInputTokens({
				contextWindow: 100,
				maxOutputTokens: 40,
				maxInputTokens: 30,
				nativeCounting: true,
			}),
		).toBe(30);
	});
	it("keeps unknown budgets unknown and rejects output that consumes the context", () => {
		expect(
			resolveLocalInferenceInputTokens({
				contextWindow: 100,
				nativeCounting: true,
			}),
		).toBeUndefined();
		expect(() =>
			resolveLocalInferenceInputTokens({
				contextWindow: 100,
				maxOutputTokens: 100,
				nativeCounting: true,
			}),
		).toThrow("no usable input");
	});
	it("retains adaptive short and long conversation targets below the trigger", () => {
		const input = {
			maxInputTokens: 100000,
			modelMaxTokens: 8000,
			triggerTokens: 97952,
		};
		expect(
			resolveAutoCompactionTargetTokens({ ...input, messagePairCount: 0 }),
		).toBe(68566);
		expect(
			resolveAutoCompactionTargetTokens({ ...input, messagePairCount: 5 }),
		).toBe(50000);
		expect(
			resolveAutoCompactionTargetTokens({
				...input,
				triggerTokens: 100,
				messagePairCount: 5,
			}),
		).toBe(99);
	});
});

describe("local model setting provenance", () => {
	it("keeps an explicit edit even when it equals the reported default", () => {
		const settings = LocalInferenceSettingsSchema.parse({
			temperature: 0.7,
			userOverrides: ["temperature"],
		});
		expect(localInferenceUserOverrides(settings, { temperature: 0.7 })).toEqual(
			["temperature"],
		);
		expect(
			localInferenceUserOverrides(
				{ temperature: 0.7, userOverrides: [] },
				{ temperature: 0.6 },
			),
		).toEqual([]);
	});
	it("infers legacy defaults conservatively and includes nested overrides", () => {
		expect(
			localInferenceUserOverrides(
				{
					contextWindow: 100,
					temperature: 0.7,
					topP: 0.9,
					compaction: { bufferTokens: 512 },
				},
				{ contextWindow: 100, temperature: 0.6 },
			),
		).toEqual(["temperature", "topP", "compaction.bufferTokens"]);
	});
});
