import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentExtension,
	type AgentTool,
	createContributionRegistry,
	type Message,
} from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultRuntimeBuilder } from "../../runtime/orchestration/runtime-builder";
import {
	readGlobalSettings,
	writeGlobalSettings,
} from "../../services/global-settings";
import { createWebProviderPlugin } from "./web-provider";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function settings(value: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "cline-search-routing-"));
	dirs.push(dir);
	vi.stubEnv("CLINE_GLOBAL_SETTINGS_PATH", join(dir, "settings.json"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(value));
}
async function tools(
	extensions: ReturnType<typeof createWebProviderPlugin>[],
): Promise<AgentTool[]> {
	const registry = createContributionRegistry<
		AgentExtension,
		AgentTool,
		Message[]
	>({
		extensions,
		setupContext: { cwd: "/workspace" },
	});
	await registry.initialize();
	return registry.getRegisteredTools();
}

describe("configuration-selected web providers", () => {
	it("registers no search tool when the provider is unconfigured or not selected", async () => {
		settings({ webSearchProvider: "searxng" });
		expect(
			await tools([
				createWebProviderPlugin({
					id: "searxng",
					isConfigured: () => false,
					search: async () => ({ results: [] }),
				}),
			]),
		).toEqual([]);
		expect(
			await tools([
				createWebProviderPlugin({
					id: "exa",
					search: async () => ({ results: [] }),
				}),
			]),
		).toEqual([]);
	});
	it("keeps exactly one tool named web_search while configuration chooses its executor", async () => {
		for (const provider of ["searxng", "exa"]) {
			settings({ webSearchProvider: provider });
			const a = vi.fn().mockResolvedValue({
				results: [{ title: "SearXNG result", url: "https://example.com/a" }],
			});
			const b = vi.fn().mockResolvedValue({
				results: [{ title: "Exa result", url: "https://example.com/b" }],
			});
			const registered = await tools([
				createWebProviderPlugin({ id: "searxng", search: a }),
				createWebProviderPlugin({ id: "exa", search: b }),
			]);
			expect(registered.map((tool) => tool.name)).toEqual(["web_search"]);
			const result = await registered[0]!.execute(
				{ query: "documentation" },
				{ agentId: "test", iteration: 0 },
			);
			expect(result).toMatchObject({ provider });
			expect(a).toHaveBeenCalledTimes(provider === "searxng" ? 1 : 0);
			expect(b).toHaveBeenCalledTimes(provider === "exa" ? 1 : 0);
		}
	});
	it("suppresses native search when an external provider is selected without falling back when its plugin is absent", async () => {
		settings({ webSearchProvider: "searxng" });
		const runtime = await new DefaultRuntimeBuilder().build({
			config: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "fixture",
				systemPrompt: "test",
				cwd: "/workspace",
				enableTools: true,
				enableSpawnAgent: false,
				enableAgentTeams: false,
				disableMcpSettingsTools: true,
			},
		});
		expect(runtime.modelTools).not.toContainEqual({ name: "web_search" });
		expect(runtime.tools.some((tool) => tool.name === "web_search")).toBe(
			false,
		);
	});
	it("keeps search and page acquisition independently configurable and preserves settings on writes", async () => {
		settings({ webSearchProvider: "searxng", webPageProvider: "fixture" });
		writeGlobalSettings({ ...readGlobalSettings(), toolAutoApprove: false });
		expect(readGlobalSettings()).toMatchObject({
			webSearchProvider: "searxng",
			webPageProvider: "fixture",
		});
		const registered = await tools([
			createWebProviderPlugin({
				id: "fixture",
				loadPage: async () => ({
					bytes: new Uint8Array(),
					url: "https://example.com",
					contentType: "text/plain",
				}),
			}),
		]);
		expect(registered.map((tool) => tool.name)).toEqual(["load_web_page"]);
	});
	it("bounds provider results and rejects backend settings injected through model arguments", async () => {
		settings({ webSearchProvider: "fixture" });
		const registered = await tools([
			createWebProviderPlugin({
				id: "fixture",
				search: async () => ({
					results: Array.from({ length: 20 }, () => ({
						title: "x".repeat(1000),
						url: "https://example.com/" + "a".repeat(1000),
						snippet: "evidence ".repeat(500),
					})),
				}),
			}),
		]);
		const tool = registered[0]!;
		const output = await tool.execute(
			{ query: "test", limit: 5 },
			{ agentId: "test", iteration: 0 },
		);
		expect(JSON.stringify(output).length).toBeLessThanOrEqual(6500);
		await expect(
			tool.execute(
				{ query: "test", baseUrl: "http://localhost" },
				{ agentId: "test", iteration: 0 },
			),
		).rejects.toThrow();
	});
});
