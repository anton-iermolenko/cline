import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderSettingsManager } from "@cline/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	activateLocalModelProfile,
	nextLocalModelProfile,
	readLocalModelProfiles,
} from "./local-model-profiles";
import type { Config } from "./types";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function fixture(providerId: string) {
	const root = mkdtempSync(join(tmpdir(), "cline-cli-model-profiles-"));
	roots.push(root);
	const manager = new ProviderSettingsManager({
		filePath: join(root, "providers.json"),
	});
	const config = {
		providerId,
		modelId: "A",
		thinking: true,
		reasoningEffort: "high",
	} as Config;
	manager.saveProviderSettings({
		provider: providerId,
		model: "A",
		baseUrl: "http://fixture/v1",
		localInference: {
			contextWindow: 150000,
			maxOutputTokens: 8000,
			thinking: true,
			reasoningEffort: "high",
			temperature: 0.4,
		},
	});
	writeFileSync(
		join(root, "models.json"),
		JSON.stringify({
			version: 1,
			providers: {
				[providerId]: { models: { A: { inputPrice: 0.01, outputPrice: 0.2 } } },
			},
		}),
	);
	return { manager, config };
}

describe("CLI native model profiles", () => {
	it("cycles D -> P1 -> P2 -> D without persisting draft changes", () => {
		const { manager } = fixture("vllm");
		const before = readFileSync(manager.getFilePath(), "utf8");
		const profiles = readLocalModelProfiles(manager, "vllm", ["A", "B"])!;
		expect(profiles).toEqual({ A: "default", B: "default" });
		profiles.A = nextLocalModelProfile(profiles.A);
		expect(profiles.A).toBe("p1");
		profiles.A = nextLocalModelProfile(profiles.A);
		expect(profiles.A).toBe("p2");
		expect(nextLocalModelProfile(profiles.A)).toBe("default");
		expect(readFileSync(manager.getFilePath(), "utf8")).toBe(before);
		expect(readLocalModelProfiles(manager, "anthropic", ["A"])).toBeUndefined();
	});
	it.each([
		"vllm",
		"llamacpp",
	])("loads complete %s slots, restores them per model, and keeps pricing shared", (providerId) => {
		const { manager, config } = fixture(providerId);
		activateLocalModelProfile(config, manager, "A", "p1");
		expect(config.providerConfig?.localInference?.temperature).toBe(0.4);
		manager.saveProviderSettings({
			...manager.getProviderSettings(providerId),
			localInference: {
				contextWindow: 150000,
				maxOutputTokens: 16000,
				thinking: false,
				temperature: 0.7,
				compaction: { targetTokens: 60000, summaryTokens: 12000 },
			},
		});
		activateLocalModelProfile(config, manager, "A", "default");
		expect(config.providerConfig?.maxOutputTokens).toBe(8000);
		expect(config.thinking).toBe(true);
		activateLocalModelProfile(config, manager, "A", "p1");
		expect(config.providerConfig).toMatchObject({
			modelId: "A",
			maxOutputTokens: 16000,
			localInference: {
				thinking: false,
				temperature: 0.7,
				compaction: { targetTokens: 60000, summaryTokens: 12000 },
			},
		});
		expect(config.thinking).toBe(false);
		expect(config.reasoningEffort).toBeUndefined();
		expect(config.knownModels?.A.pricing).toMatchObject({
			input: 0.01,
			output: 0.2,
		});
		activateLocalModelProfile(config, manager, "A", "p2");
		expect(config.providerConfig?.localInference?.temperature).toBe(0.4);
		manager.saveProviderSettings({
			...manager.getProviderSettings(providerId),
			model: "B",
			localInference: { contextWindow: 100000, maxOutputTokens: 4000 },
		});
		// New model profiles must have an explicit context limit before activation.
		manager.saveProviderSettings({
			...manager.getProviderSettings(providerId),
			localInference: { contextWindow: 100000, maxOutputTokens: 4000 },
		});
		activateLocalModelProfile(config, manager, "B", "p1");
		expect(config.modelId).toBe("B");
		expect(config.providerConfig?.maxOutputTokens).toBe(4000);
		activateLocalModelProfile(config, manager, "A", "p1");
		expect(config.providerConfig?.maxOutputTokens).toBe(16000);
		expect(readLocalModelProfiles(manager, providerId, ["A", "B"])).toEqual({
			A: "p1",
			B: "p1",
		});
		const fresh = new ProviderSettingsManager({
			filePath: manager.getFilePath(),
		});
		expect(fresh.getLocalModelProfileId(providerId, "A")).toBe("p1");
		expect(
			fresh.getProviderConfig(providerId)?.localInference?.temperature,
		).toBe(0.7);
	});
	it("keeps selected model and disk settings unchanged if the target profile is invalid", () => {
		const { manager, config } = fixture("vllm");
		const before = readFileSync(manager.getFilePath(), "utf8");
		expect(() =>
			activateLocalModelProfile(config, manager, "missing-context", "p1"),
		).toThrow(/context/i);
		expect(config.modelId).toBe("A");
		expect(readFileSync(manager.getFilePath(), "utf8")).toBe(before);
	});
});
