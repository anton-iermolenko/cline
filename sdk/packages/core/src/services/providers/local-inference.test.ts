import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSettingsManager } from "../storage/provider-settings-manager";
import {
	discoverLocalInferenceModels,
	getLocalModelDefaults,
	parseLocalModelDefaults,
} from "./local-inference-discovery";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
});
function manager() {
	const dir = mkdtempSync(join(tmpdir(), "cline-native-settings-"));
	dirs.push(dir);
	return new ProviderSettingsManager({ filePath: join(dir, "providers.json") });
}
describe("native local model profiles", () => {
	it("restores a complete profile after A -> B -> A and never copies credentials", () => {
		const store = manager();
		const a = {
			contextWindow: 10000,
			maxOutputTokens: 2000,
			thinkingBudgetTokens: 500,
			temperature: 0.7,
			compaction: { bufferTokens: 100, targetTokens: 3000 },
		};
		store.saveProviderSettings({
			provider: "vllm",
			model: "A",
			baseUrl: "http://server/v1",
			apiKey: "fixture-secret",
			localInference: a,
		});
		store.saveProviderSettings({
			...store.getProviderSettings("vllm"),
			model: "B",
		});
		expect(store.getProviderSettings("vllm")?.localInference).toEqual({});
		store.saveProviderSettings({
			...store.getProviderSettings("vllm"),
			localInference: {
				contextWindow: 20000,
				maxOutputTokens: 4000,
				thinking: false,
			},
		});
		store.saveProviderSettings({
			...store.getProviderSettings("vllm"),
			model: "A",
		});
		expect(store.getProviderSettings("vllm")?.localInference).toEqual(a);
		expect(store.getLastUsedProviderSettings()?.model).toBe("A");
		expect(
			JSON.stringify(store.read().providers.vllm.localModelProfiles),
		).not.toContain("fixture-secret");
		const fresh = new ProviderSettingsManager({
			filePath: store.getFilePath(),
		});
		expect(fresh.getProviderConfig("vllm")).toMatchObject({
			modelId: "A",
			maxOutputTokens: 2000,
			localInference: a,
		});
	});
	it("scopes configurations to provider, endpoint and model and preserves URL-specific profiles", () => {
		const store = manager();
		store.saveProviderSettings({
			provider: "vllm",
			model: "same",
			baseUrl: "http://one/v1",
			localInference: { maxOutputTokens: 100 },
		});
		store.saveProviderSettings({
			...store.getProviderSettings("vllm"),
			baseUrl: "http://two/v1",
		});
		expect(store.getProviderSettings("vllm")?.localInference).toEqual({});
		store.saveProviderSettings({
			...store.getProviderSettings("vllm"),
			baseUrl: "http://one/v1",
		});
		expect(
			store.getProviderSettings("vllm")?.localInference?.maxOutputTokens,
		).toBe(100);
		store.saveProviderSettings({
			provider: "llamacpp",
			model: "same",
			baseUrl: "http://one/v1",
		});
		expect(store.getProviderSettings("llamacpp")?.localInference).toEqual({});
		expect(readFileSync(store.getFilePath(), "utf8")).not.toContain(
			"slow_response_guard",
		);
	});
	it("initializes from available server metadata without filtering engines or inventing unknown defaults", async () => {
		const fetcher = vi.fn(
			async (_input: Parameters<typeof fetch>[0]) =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "discovered",
								context_window: 153600,
								meta: { llamaswap: { engine: "something-else" } },
								capabilities: { vision: true, function_calling: true },
								default_generation_settings: {
									params: { temperature: 0.6, max_tokens: 7000 },
								},
							},
							{ id: "unknown" },
						],
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
		);
		const config = {
			providerId: "vllm" as const,
			modelId: "discovered",
			baseUrl: "http://discovery/v1",
			fetch: fetcher as unknown as typeof fetch,
		};
		const models = await discoverLocalInferenceModels(config);
		expect(Object.keys(models)).toEqual(["discovered", "unknown"]);
		expect(getLocalModelDefaults(config.baseUrl, "unknown", "vllm")).toEqual(
			{},
		);
		const store = manager();
		store.saveProviderSettings({
			provider: "vllm",
			baseUrl: config.baseUrl,
			model: "discovered",
		});
		expect(store.getProviderSettings("vllm")?.localInference).toMatchObject({
			contextWindow: 153600,
			maxOutputTokens: 7000,
			temperature: 0.6,
		});
		store.saveProviderSettings({
			provider: "vllm",
			baseUrl: config.baseUrl,
			model: "discovered",
			localInference: {},
		});
		expect(store.getProviderConfig("vllm")?.localInference).toMatchObject({
			contextWindow: 153600,
			maxOutputTokens: 7000,
		});
		expect(store.getProviderSettings("vllm")?.localInference).toEqual({});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			"http://discovery/v1/models",
		);
	});
	it("ignores invalid/unlimited defaults individually and preserves reported counter absence", () => {
		expect(
			parseLocalModelDefaults({
				context_window: 4096,
				input_token_counting: false,
				default_generation_settings: {
					params: { n_predict: -1, temperature: 0 },
				},
			}),
		).toEqual({
			contextWindow: 4096,
			inputTokenCounting: false,
			temperature: 0,
		});
	});
});
