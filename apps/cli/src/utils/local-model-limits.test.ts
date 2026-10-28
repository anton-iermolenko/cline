import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CoreCompactionContext,
	ProviderSettingsManager,
} from "@cline/core";
import {
	applyLocalModelLimits,
	createContextCompactionPrepareTurn,
} from "@cline/core";
import { estimateRequestInputTokens } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./types";

const roots: string[] = [];
function fixture(models: unknown) {
	const root = mkdtempSync(join(tmpdir(), "cline-local-limits-"));
	roots.push(root);
	const settings = join(root, "settings");
	mkdirSync(settings);
	writeFileSync(
		join(settings, "models.json"),
		JSON.stringify({
			version: 1,
			providers: { "openai-compatible": { models } },
		}),
	);
	return {
		getFilePath: () => join(settings, "providers.json"),
	} as ProviderSettingsManager;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("local model limits", () => {
	it("maps stored per-million-token prices into model pricing", () => {
		const config = {
			providerId: "openai-compatible",
			modelId: "qwen-27b",
		} as Pick<Config, "providerId" | "modelId" | "knownModels">;
		applyLocalModelLimits(
			config,
			fixture({ "qwen-27b": { inputPrice: 0.02, outputPrice: 0.35 } }),
		);
		expect(config.knownModels?.["qwen-27b"].pricing).toMatchObject({
			input: 0.02,
			output: 0.35,
		});
	});
	it("preserves catalog rates for partial overrides and accepts zero cache prices", () => {
		const config = {
			providerId: "openai-compatible",
			modelId: "custom",
			knownModels: {
				custom: {
					id: "custom",
					pricing: { input: 9, output: 2, cacheRead: 1, cacheWrite: 3 },
				},
			},
		} as Pick<Config, "providerId" | "modelId" | "knownModels">;
		applyLocalModelLimits(
			config,
			fixture({
				custom: { inputPrice: 0, cacheReadsPrice: 0, cacheWritesPrice: 0 },
			}),
		);
		expect(config.knownModels?.custom.pricing).toEqual({
			input: 0,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("supplies custom model limits when the SDK catalog has no matching model", () => {
		const config: Pick<Config, "providerId" | "modelId" | "knownModels"> = {
			providerId: "openai-compatible",
			modelId: "qwen-27b",
			knownModels: {},
		};
		applyLocalModelLimits(
			config,
			fixture({
				"qwen-27b": {
					contextWindow: 81920,
					maxInputTokens: 73728,
					maxTokens: 8192,
				},
			}),
		);
		expect(config.knownModels?.["qwen-27b"]).toMatchObject({
			id: "qwen-27b",
			contextWindow: 81920,
			maxInputTokens: 73728,
			maxTokens: 8192,
		});
	});
	it("triggers real automatic compaction near 66K instead of the 128K fallback", async () => {
		const config = {
			providerId: "openai-compatible",
			modelId: "qwen-27b",
		} as Pick<Config, "providerId" | "modelId" | "knownModels">;
		applyLocalModelLimits(
			config,
			fixture({
				"qwen-27b": {
					contextWindow: 81920,
					maxInputTokens: 73728,
					maxTokens: 8192,
				},
			}),
		);
		const compact = vi.fn(async (_context: CoreCompactionContext) => undefined);
		const prepare = createContextCompactionPrepareTurn({
			providerId: "openai-compatible",
			modelId: "qwen-27b",
			compaction: { enabled: true, compact },
		});
		type Turn = Parameters<NonNullable<typeof prepare>>[0];
		function turn(tokens: number): Turn {
			let low = 0,
				high = tokens * 8;
			while (low < high) {
				const length = Math.floor((low + high) / 2);
				const estimate = estimateRequestInputTokens({
					systemPrompt: "",
					messages: [{ role: "user", content: "a".repeat(length) }],
					tools: [],
				});
				if (estimate < tokens) low = length + 1;
				else high = length;
			}
			const messages = [{ role: "user" as const, content: "a".repeat(low) }];
			return {
				agentId: "test",
				conversationId: "test",
				parentAgentId: null,
				iteration: 1,
				abortSignal: new AbortController().signal,
				messages,
				apiMessages: messages,
				systemPrompt: "",
				tools: [],
				model: {
					id: "qwen-27b",
					provider: "openai-compatible",
					info: config.knownModels?.["qwen-27b"],
				},
			} as Turn;
		}
		await prepare?.(turn(66000));
		expect(compact).not.toHaveBeenCalled();
		await prepare?.(turn(67000));
		expect(compact).toHaveBeenCalledOnce();
		expect(compact.mock.calls[0][0]).toMatchObject({
			mode: "auto",
			budget: { request: { maxInputTokens: 73728, triggerTokens: 66355.2 } },
		});
	});

	it("preserves catalog capabilities while local numeric overrides win", () => {
		const config: Pick<Config, "providerId" | "modelId" | "knownModels"> = {
			providerId: "openai-compatible",
			modelId: "qwen-27b",
			knownModels: {
				"qwen-27b": {
					id: "qwen-27b",
					contextWindow: 128000,
					capabilities: ["tools"],
				},
			},
		};
		applyLocalModelLimits(
			config,
			fixture({ "qwen-27b": { contextWindow: 81920, maxTokens: 8192 } }),
		);
		expect(config.knownModels?.["qwen-27b"]).toMatchObject({
			contextWindow: 81920,
			maxInputTokens: 73728,
			capabilities: ["tools"],
		});
	});
	it("reserves output space even if the stored input limit equals total context", () => {
		const config = {
			providerId: "openai-compatible",
			modelId: "custom",
		} as Pick<Config, "providerId" | "modelId" | "knownModels">;
		applyLocalModelLimits(
			config,
			fixture({
				custom: {
					contextWindow: 81920,
					maxInputTokens: 81920,
					maxTokens: 8192,
				},
			}),
		);
		expect(config.knownModels?.custom.maxInputTokens).toBe(73728);
	});
	it("reloads updated limits on model changes without sharing model info objects", () => {
		const manager = fixture({ small: { contextWindow: 4096, maxTokens: 512 } });
		const config = {
			providerId: "openai-compatible",
			modelId: "small",
		} as Pick<Config, "providerId" | "modelId" | "knownModels">;
		applyLocalModelLimits(config, manager);
		const original = config.knownModels?.small;
		writeFileSync(
			join(manager.getFilePath(), "..", "models.json"),
			JSON.stringify({
				version: 1,
				providers: {
					"openai-compatible": {
						models: { small: { contextWindow: 8192, maxTokens: 1024 } },
					},
				},
			}),
		);
		applyLocalModelLimits(config, manager);
		expect(config.knownModels?.small.maxInputTokens).toBe(7168);
		expect(original?.maxInputTokens).toBe(3584);
	});
	it("preserves an intentional lower input cap on a sparse output update", () => {
		const config = {
			providerId: "openai-compatible",
			modelId: "custom",
			knownModels: {
				custom: {
					id: "custom",
					contextWindow: 81920,
					maxInputTokens: 20000,
					maxTokens: 8192,
				},
			},
		};
		applyLocalModelLimits(config, fixture({ custom: { maxTokens: 4096 } }));
		expect(config.knownModels.custom.maxInputTokens).toBe(20000);
	});
	it.each([
		0,
		-1,
		1.5,
		"81920",
	])("rejects invalid stored context %s", (contextWindow) => {
		expect(() =>
			applyLocalModelLimits(
				{ providerId: "openai-compatible", modelId: "custom" },
				fixture({ custom: { contextWindow } }),
			),
		).toThrow("positive integer");
	});
	it("rejects output that consumes the whole context", () => {
		expect(() =>
			applyLocalModelLimits(
				{ providerId: "openai-compatible", modelId: "custom" },
				fixture({ custom: { contextWindow: 8192, maxTokens: 8192 } }),
			),
		).toThrow("no input capacity");
	});

	it("keeps catalog-only models unchanged when no local override exists", () => {
		const config = {
			providerId: "openai-compatible",
			modelId: "other",
			knownModels: { other: { id: "other", maxInputTokens: 4000 } },
		} as Pick<Config, "providerId" | "modelId" | "knownModels">;
		applyLocalModelLimits(config, fixture({}));
		expect(config.knownModels?.other.maxInputTokens).toBe(4000);
	});
});
