import { describe, expect, it, vi } from "vitest";
import {
	createContextBar,
	formatStatusBarUsageText,
	resolveContextBarFilledForeground,
	resolveModelDisplayName,
} from "./status-bar";

vi.mock("@opentui/react", () => ({
	useTerminalDimensions: () => ({ width: 80, height: 24 }),
}));

describe("createContextBar", () => {
	it("keeps a stable width while changing segment lengths", () => {
		expect(createContextBar(0, 100)).toEqual({
			filled: "",
			empty: "\u2588\u2588\u2588\u2588\u2588\u2588",
		});
		expect(createContextBar(50, 100)).toEqual({
			filled: "\u2588\u2588\u2588",
			empty: "\u2588\u2588\u2588",
		});
		expect(createContextBar(100, 100)).toEqual({
			filled: "\u2588\u2588\u2588\u2588\u2588\u2588",
			empty: "",
		});
	});

	it("shows a non-empty fill when usage is above zero", () => {
		expect(createContextBar(7_000, 1_000_000)).toEqual({
			filled: "▏",
			empty: "\u2588\u2588\u2588\u2588\u2588",
		});
	});

	it("keeps the final block partial until usage reaches the limit", () => {
		expect(createContextBar(999_999, 1_000_000)).toEqual({
			filled: "█████▉",
			empty: "",
		});
		expect(createContextBar(1_000_000, 1_000_000)).toEqual({
			filled: "\u2588\u2588\u2588\u2588\u2588\u2588",
			empty: "",
		});
	});

	it("shows the reported 63K input proportionally within the 92K allowance", () => {
		expect(createContextBar(63_284, 92_160)).toEqual({
			filled: "████▏",
			empty: "█",
		});
		expect(createContextBar(80_000, 92_160)).toEqual({
			filled: "█████▎",
			empty: "",
		});
	});

	it("keeps the total width stable with partial blocks", () => {
		for (const width of [0, 1, 6, 12]) {
			for (const used of [0, 1, 63_284, 90_000, 92_160, 100_000]) {
				const bar = createContextBar(used, 92_160, width);
				expect(bar.filled.length + bar.empty.length).toBe(width);
			}
		}
	});

	it("uses explicit white when terminal foreground would inherit gray", () => {
		expect(resolveContextBarFilledForeground(undefined)).toBe("#ffffff");
		expect(resolveContextBarFilledForeground("#1a1a1a")).toBe("#1a1a1a");
	});
});

describe("formatStatusBarUsageText", () => {
	it("includes cost when usage cost is visible", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 12_345,
				totalCost: 0.123,
				providerId: "cline",
			}),
		).toBe("(12,345 last input) $0.12");
	});

	it("rounds cost to two decimals even when tiny", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 12_345,
				totalCost: 0.0004,
				providerId: "cline",
			}),
		).toBe("(12,345 last input) $0.00");
	});

	it("hides cost entirely for subscription providers", () => {
		expect(
			formatStatusBarUsageText({
				totalTokens: 12_345,
				totalCost: 0.123,
				providerId: "cline-pass",
			}),
		).toBe("(12,345 last input)");
	});
});

describe("resolveModelDisplayName", () => {
	it("uses the full model id with a ClinePass prefix", () => {
		expect(
			resolveModelDisplayName({
				providerId: "cline-pass",
				modelId: "zai/glm-5.2",
				knownModels: {
					"zai/glm-5.2": { name: "GLM 5.2" },
				},
			}),
		).toBe("ClinePass: zai/glm-5.2");
	});

	it("keeps the full unknown model id with a ClinePass prefix", () => {
		expect(
			resolveModelDisplayName({
				providerId: "cline-pass",
				modelId: "zai/glm-5.2",
			}),
		).toBe("ClinePass: zai/glm-5.2");
	});

	it("keeps the reasoning effort next to the model name", () => {
		expect(
			resolveModelDisplayName({
				providerId: "cline-pass",
				modelId: "zai/glm-5.2",
				knownModels: {
					"zai/glm-5.2": { name: "GLM 5.2" },
				},
				thinking: true,
				reasoningEffort: "high",
			}),
		).toBe("ClinePass: zai/glm-5.2 (high)");
	});

	it("uses the model id for non-ClinePass providers", () => {
		expect(
			resolveModelDisplayName({
				providerId: "cline",
				modelId: "zai/glm-5.2",
				knownModels: {
					"zai/glm-5.2": { name: "GLM 5.2" },
				},
			}),
		).toBe("zai/glm-5.2");
	});
});

describe("native footer profile", () => {
	it.each([
		["default", "D"],
		["p1", "P1"],
		["p2", "P2"],
	] as const)("shows the selected %s slot beside the exact id", (profile, label) => {
		expect(
			resolveModelDisplayName({
				providerId: "vllm",
				modelId: "qwen-27b-max-context",
				knownModels: { "qwen-27b-max-context": { name: "Friendly name" } },
				localModelProfile: profile,
			}),
		).toBe(`qwen-27b-max-context (${label})`);
	});
});
