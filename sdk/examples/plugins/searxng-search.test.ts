import { describe, expect, it, vi } from "vitest";
import { parseSearxngSettings, searchSearxng } from "./searxng-search";
import { searchWeb } from "./web-search";

describe("SearXNG provider adapter", () => {
	const settings = {
		baseUrl: "https://search.example.com",
		defaultEngines: ["custom google"],
		language: "en",
		safeSearch: 1 as const,
	};
	it("uses trusted connection, engine and SafeSearch settings and a bounded response", async () => {
		const transport = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							title: "<b>Documentation</b>",
							url: "https://example.com/docs",
							content: "Evidence",
							engines: ["custom google"],
						},
					],
				}),
			),
		);
		const result = await searchSearxng(
			{ query: "documentation" },
			settings,
			undefined,
			transport,
		);
		const [url, request] = transport.mock.calls[0]!;
		expect(String(url)).toBe("https://search.example.com/search");
		const body = request?.body as URLSearchParams;
		expect(body.get("engines")).toBe("custom google");
		expect(body.get("safesearch")).toBe("1");
		expect(request?.redirect).toBe("error");
		expect(result.results[0]?.title).toBe("Documentation");
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(6500);
	});
	it("does not switch providers on rate limits", async () => {
		const transport = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("", { status: 429 }));
		await expect(
			searchSearxng({ query: "documentation" }, settings, undefined, transport),
		).rejects.toThrow("no fallback");
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it("rejects model-injected settings and engine operators", async () => {
		await expect(
			searchSearxng({ query: "!google documentation" }, settings),
		).rejects.toThrow("operators");
		await expect(
			searchSearxng(
				{ query: "documentation", safeSearch: 0 } as never,
				settings,
			),
		).rejects.toThrow("supported search arguments");
		expect(() =>
			parseSearxngSettings({
				...settings,
				baseUrl: "https://user:password@search.example.com",
			}),
		).toThrow("without credentials");
	});
	it("bounds large snippets and rejects oversized upstream responses", async () => {
		const transport = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					results: Array.from({ length: 30 }, () => ({
						title: "t".repeat(1000),
						url: "https://example.com/" + "x".repeat(1000),
						content: "e".repeat(10000),
					})),
				}),
			),
		);
		expect(
			JSON.stringify(
				await searchSearxng(
					{ query: "documentation", max_results: 5 },
					settings,
					undefined,
					transport,
				),
			).length,
		).toBeLessThanOrEqual(6500);
		const huge = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("x".repeat(2 * 1024 * 1024 + 1)));
		await expect(
			searchSearxng({ query: "documentation" }, settings, undefined, huge),
		).rejects.toThrow("2 MiB");
	});
});

describe("Exa provider compatibility", () => {
	it("retains Exa routing and filters", async () => {
		vi.stubEnv("EXA_API_KEY", "fixture-key");
		const transport = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: "fixture",
					results: [
						{
							title: "Exa documentation",
							url: "https://example.com/exa",
							highlights: ["Evidence"],
						},
					],
				}),
			),
		);
		vi.stubGlobal("fetch", transport);
		try {
			const result = await searchWeb({
				query: "documentation",
				limit: 2,
				domains: ["example.com"],
				recencyDays: 7,
			});
			expect(result.provider).toBe("exa");
			expect(result.results[0]?.snippet).toBe("Evidence");
			const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body));
			expect(body.includeDomains).toEqual(["example.com"]);
			expect(body.numResults).toBe(2);
			expect(body.startPublishedDate).toBeDefined();
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});
});
