import { describe, expect, it } from "vitest";
import {
	LocalInferenceSettingsSchema,
	localInferenceUserOverrides,
	resolveLocalInferenceSettings,
} from "./local-inference";
import {
	resolveCompactionDefaults,
	resolveLocalInferenceInputTokens,
	resolveLocalModelBudget,
} from "./local-model-budget";

describe("continuous local compaction budgets", () => {
	it.each([
		[40000, 4000, 10000, 24000],
		[64000, 8000, 14000, 32000],
		[100000, 10000, 25000, 45000],
		[150000, 14000, 40000, 64000],
		[200000, 16000, 60000, 86000],
		[300000, 16000, 60000, 86000],
	])("matches the reference allocation at %i context tokens", (contextWindow, summaryTokens, recentTokens, targetTokens) => {
		const b = resolveLocalModelBudget({ contextWindow, maxOutputTokens: 8000 });
		expect(b).toMatchObject({
			summaryTokens,
			recentTokens,
			targetTokens,
			marginTokens: 128,
		});
		expect(b.inputCapTokens).toBe(contextWindow - 8000 - 1 - 128);
		expect(b.iterationReserveTokens).toBe(Math.ceil((contextWindow * 2) / 15));
		expect(b.hardCapTokens + b.iterationReserveTokens).toBe(b.inputCapTokens);
		expect(b.growthTokens).toBeGreaterThanOrEqual(b.iterationReserveTokens);
		expect(
			10000 +
				b.summaryTokens +
				b.recentTokens +
				b.maxOutputTokens +
				b.marginTokens +
				b.boundaryTokens +
				b.growthTokens,
		).toBe(contextWindow);
	});
	it("enforces a growing minimum reserve without changing the compaction trigger", () => {
		for (const contextWindow of [
			16000, 32000, 40000, 64000, 100000, 150000, 200000, 300000, 1000000,
		]) {
			const defaults = resolveLocalModelBudget({
				contextWindow,
				maxOutputTokens: 2000,
			});
			const full = resolveLocalModelBudget({
				contextWindow,
				maxOutputTokens: 2000,
				compaction: { targetTokens: defaults.hardCapTokens },
			});
			expect(full.growthTokens).toBe(full.iterationReserveTokens);
			expect(() =>
				resolveLocalModelBudget({
					contextWindow,
					maxOutputTokens: 2000,
					compaction: { targetTokens: defaults.hardCapTokens + 1 },
				}),
			).toThrow("hard cap");
		}
		const b = resolveLocalModelBudget({
			contextWindow: 150000,
			maxOutputTokens: 8000,
		});
		expect(b).toMatchObject({
			inputCapTokens: 141871,
			hardCapTokens: 121871,
			iterationReserveTokens: 20000,
			targetTokens: 64000,
			growthTokens: 77871,
		});
		const next = resolveLocalModelBudget({
			contextWindow: 150001,
			maxOutputTokens: 8000,
		});
		expect(
			next.iterationReserveTokens - b.iterationReserveTokens,
		).toBeLessThanOrEqual(1);
		expect(() =>
			resolveLocalModelBudget({ contextWindow: 10000, maxOutputTokens: 9000 }),
		).toThrow("iteration reserve");
	});
	it("interpolates gradually and plateaus without conversation-count thresholds", () => {
		expect(resolveCompactionDefaults(82000)).toEqual({
			summaryTokens: 9000,
			recentTokens: 19500,
			targetTokens: 38500,
		});
		let previous = resolveCompactionDefaults(39000).targetTokens;
		for (let c = 40000; c <= 301000; c += 1000) {
			const next = resolveCompactionDefaults(c).targetTokens;
			expect(next).toBeGreaterThanOrEqual(previous);
			expect(next - previous).toBeLessThan(1000);
			previous = next;
		}
		expect(resolveCompactionDefaults(200001)).toEqual(
			resolveCompactionDefaults(300000),
		);
	});
	it("normal output changes growth space without changing summary or fresh-history defaults", () => {
		const a = resolveLocalModelBudget({
			contextWindow: 150000,
			maxOutputTokens: 8000,
		});
		const b = resolveLocalModelBudget({
			contextWindow: 150000,
			maxOutputTokens: 16000,
		});
		expect([a.summaryTokens, a.recentTokens, a.targetTokens]).toEqual([
			b.summaryTokens,
			b.recentTokens,
			b.targetTokens,
		]);
		expect(a.growthTokens - b.growthTokens).toBe(8000);
	});
	it("replaces the preview overhead with real overhead at runtime", () => {
		const raw = {
			contextWindow: 150000,
			maxOutputTokens: 8000,
			compaction: { targetTokens: 61000, summaryTokens: 14000 },
		};
		expect(resolveLocalModelBudget(raw).recentTokens).toBe(37000);
		expect(
			resolveLocalModelBudget(raw, { overheadTokens: 12345 }).recentTokens,
		).toBe(34655);
	});
	it("rejects unknown capacity and budgets beyond available context", () => {
		expect(() => resolveLocalModelBudget({ maxOutputTokens: 8000 })).toThrow(
			"Maximum context size is required",
		);
		expect(() =>
			resolveLocalModelBudget({ contextWindow: 40000, maxOutputTokens: 40000 }),
		).toThrow("no usable input");
		expect(() =>
			resolveLocalModelBudget({
				contextWindow: 40000,
				maxOutputTokens: 8000,
				compaction: { targetTokens: 35000 },
			}),
		).toThrow("hard cap");
		expect(() =>
			resolveLocalModelBudget({
				contextWindow: 40000,
				compaction: { targetTokens: 20000, summaryTokens: 20000 },
			}),
		).toThrow("smaller");
	});
	it("keeps explicit inactive values recoverable and restores reported context/output", () => {
		const raw = LocalInferenceSettingsSchema.parse({
			contextWindow: 120000,
			maxOutputTokens: 16000,
			serverDefaults: { contextWindow: 150000, maxOutputTokens: 8000 },
			compaction: { targetTokens: 50000, summaryTokens: 12000 },
			userOverrides: [
				"contextWindow",
				"maxOutputTokens",
				"compaction.targetTokens",
				"compaction.summaryTokens",
			],
			disabledOverrides: [
				"contextWindow",
				"maxOutputTokens",
				"compaction.targetTokens",
			],
		});
		const b = resolveLocalModelBudget(raw);
		expect(b).toMatchObject({
			contextWindow: 150000,
			maxOutputTokens: 8000,
			targetTokens: 64000,
			summaryTokens: 12000,
			recentTokens: 42000,
		});
		expect(raw.compaction?.targetTokens).toBe(50000);
		expect(raw.contextWindow).toBe(120000);
		expect(
			resolveLocalModelBudget({ ...raw, disabledOverrides: [] }).targetTokens,
		).toBe(50000);
	});
	it("allows zero margin and reserves thinking once through total normal output", () => {
		expect(
			resolveLocalModelBudget({
				contextWindow: 100000,
				maxOutputTokens: 8000,
				thinkingBudgetTokens: 2000,
				compaction: { bufferTokens: 0 },
			}).inputCapTokens,
		).toBe(91999);
		expect(
			resolveLocalInferenceInputTokens({
				contextWindow: 100,
				maxOutputTokens: 20,
				nativeCounting: true,
			}),
		).toBe(79);
	});
});
describe("setting provenance", () => {
	it("keeps explicit same-value overrides and infers legacy differences", () => {
		expect(
			localInferenceUserOverrides(
				{ temperature: 0.7, userOverrides: ["temperature"] },
				{ temperature: 0.7 },
			),
		).toEqual(["temperature"]);
		expect(
			localInferenceUserOverrides(
				{ temperature: 0.7, topP: 0.9 },
				{ temperature: 0.7 },
			),
		).toEqual(["topP"]);
	});
	it("projects inactive settings without mutating stored values", () => {
		const raw = {
			contextWindow: 100000,
			compaction: { targetTokens: 50000 },
			disabledOverrides: ["compaction.targetTokens" as const],
		};
		expect(
			resolveLocalInferenceSettings(raw).compaction?.targetTokens,
		).toBeUndefined();
		expect(raw.compaction.targetTokens).toBe(50000);
	});
});

it("rejects non-integral capacities and restores a cleared manual context from the server default", () => {
	expect(() => resolveLocalModelBudget({ contextWindow: Infinity })).toThrow(
		"whole number",
	);
	expect(() => resolveLocalModelBudget({ contextWindow: 150000.5 })).toThrow(
		"whole number",
	);
	expect(
		resolveLocalInferenceSettings({
			serverDefaults: { contextWindow: 150000, maxOutputTokens: 8000 },
		}).contextWindow,
	).toBe(150000);
});

it("uses 128 tokens only with native preflight and 2048 when counts are estimated", () => {
	const base = { contextWindow: 150000, maxOutputTokens: 8000 };
	expect(resolveLocalModelBudget(base).marginTokens).toBe(128);
	expect(
		resolveLocalModelBudget({ ...base, inputTokenCounting: false }),
	).toMatchObject({
		marginTokens: 2048,
		boundaryTokens: 0,
		inputCapTokens: 139952,
		hardCapTokens: 119952,
	});
	expect(
		resolveLocalModelBudget({
			...base,
			inputTokenCounting: false,
			compaction: { bufferTokens: 256 },
		}).marginTokens,
	).toBe(256);
});
