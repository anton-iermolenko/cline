/** Optional search backend. Page retrieval is provided by Cline's built-in page tools. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolContext,
	createWebProviderPlugin,
	type WebSearchInput,
	type WebSearchResponse,
} from "@cline/core";

export interface SearxngSettings {
	baseUrl: string;
	defaultEngines?: string[];
	language?: string;
	safeSearch?: 0 | 1 | 2;
	/** Optional host-configured authentication headers; never taken from model input. */
	headers?: Record<string, string>;
}
export interface SearxngInput {
	query: string;
	provider?: "default" | "brave" | "duckduckgo" | "bing" | "google";
	max_results?: number;
	language?: string;
}
const PROVIDERS = {
	brave: ["brave"],
	duckduckgo: ["duckduckgo"],
	bing: ["bing"],
	google: ["google"],
} as const;
const MAX_OUTPUT = 6500;

function clean(value: unknown, limit: number): string {
	return typeof value === "string"
		? value
				.replace(/<[^>]*>/g, " ")
				.replace(/&amp;/g, "&")
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, limit)
		: "";
}
export function parseSearxngSettings(value: unknown): SearxngSettings {
	if (!value || typeof value !== "object")
		throw new Error("SearXNG settings must be a JSON object");
	const settings = value as SearxngSettings;
	const url = new URL(settings.baseUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(
			"SearXNG baseUrl must be HTTP(S), without credentials, query or fragment",
		);
	if (
		settings.safeSearch !== undefined &&
		![0, 1, 2].includes(settings.safeSearch)
	)
		throw new Error("safeSearch must be 0, 1 or 2");
	if (
		settings.defaultEngines !== undefined &&
		(!Array.isArray(settings.defaultEngines) ||
			settings.defaultEngines.length < 1 ||
			settings.defaultEngines.length > 5 ||
			settings.defaultEngines.some(
				(engine) =>
					typeof engine !== "string" ||
					!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/.test(engine),
			))
	)
		throw new Error("defaultEngines must contain 1–5 SearXNG engine names");
	if (
		settings.language !== undefined &&
		!/^(?:all|[a-zA-Z]{2}(?:[-_][a-zA-Z]{2})?)$/.test(settings.language)
	)
		throw new Error("Invalid configured language");
	if (
		settings.headers !== undefined &&
		(typeof settings.headers !== "object" ||
			settings.headers === null ||
			Array.isArray(settings.headers) ||
			Object.values(settings.headers).some(
				(v) => typeof v !== "string" || /[\r\n]/.test(v),
			))
	)
		throw new Error("headers must contain string values without newlines");
	return settings;
}

/** Reads trusted local settings on each call; changing a backend does not require editing plugin code. */
export async function readSearxngSettings(): Promise<SearxngSettings> {
	const path =
		process.env.CLINE_SEARXNG_CONFIG ??
		join(homedir(), ".cline", "searxng.json");
	try {
		return parseSearxngSettings(JSON.parse(await readFile(path, "utf8")));
	} catch {
		throw new Error(
			"Configure the SearXNG plugin in ~/.cline/searxng.json (or CLINE_SEARXNG_CONFIG), including baseUrl, defaultEngines, language and safeSearch",
		);
	}
}

export async function searchSearxng(
	input: SearxngInput,
	settings: SearxngSettings,
	signal?: AbortSignal,
	transport: typeof fetch = fetch,
) {
	settings = parseSearxngSettings(settings);
	if (
		!input ||
		typeof input.query !== "string" ||
		!input.query.trim() ||
		input.query.length > 500 ||
		Object.keys(input).some(
			(key) => !["query", "provider", "max_results", "language"].includes(key),
		)
	)
		throw new Error(
			"Provide a query of 1–500 characters and only supported search arguments",
		);
	if (/(^|\s)[!:]\S/.test(input.query))
		throw new Error(
			"Engine/language operators are disabled; use provider and language arguments",
		);
	const provider = input.provider ?? "default",
		count = input.max_results ?? 3,
		language = input.language ?? settings.language ?? "en";
	if (provider !== "default" && !Object.hasOwn(PROVIDERS, provider))
		throw new Error("Invalid search provider");
	if (!Number.isInteger(count) || count < 1 || count > 5)
		throw new Error("max_results must be 1–5");
	if (!/^(?:all|[a-zA-Z]{2}(?:[-_][a-zA-Z]{2})?)$/.test(language))
		throw new Error("Invalid search language");
	const engines =
		provider === "default" ? settings.defaultEngines : PROVIDERS[provider];
	const url = new URL(settings.baseUrl);
	if (!url.pathname || url.pathname === "/") url.pathname = "/search";
	const body = new URLSearchParams({
		q: input.query.trim(),
		format: "json",
		language,
		safesearch: String(settings.safeSearch ?? 1),
	});
	if (engines?.length) body.set("engines", engines.join(","));
	const response = await transport(url, {
		method: "POST",
		redirect: "error",
		headers: {
			...settings.headers,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(25_000)])
			: AbortSignal.timeout(25_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(
			`SearXNG returned HTTP ${response.status}; no fallback provider was selected`,
		);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("SearXNG returned no body");
	let length = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > 2 * 1024 * 1024)
				throw new Error("SearXNG response exceeds 2 MiB");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (
		!data ||
		typeof data !== "object" ||
		!Array.isArray((data as { results?: unknown }).results)
	)
		throw new Error("Invalid JSON results from SearXNG");
	const payload = data as {
		results: unknown[];
		unresponsive_engines?: unknown[];
	};
	const results = payload.results
		.flatMap((entry) => {
			if (!entry || typeof entry !== "object") return [];
			const result = entry as Record<string, unknown>;
			if (typeof result.url !== "string" || result.url.length > 1200) return [];
			try {
				const u = new URL(result.url);
				if (
					!["http:", "https:"].includes(u.protocol) ||
					u.username ||
					u.password
				)
					return [];
			} catch {
				return [];
			}
			return [
				{
					title: clean(result.title, 180),
					url: result.url,
					snippet: clean(result.content, 550),
					engines: (Array.isArray(result.engines)
						? result.engines
						: [result.engine]
					)
						.slice(0, 5)
						.map((engine) => clean(engine, 60))
						.filter(Boolean),
				},
			];
		})
		.slice(0, count);
	const result = {
		provider: "searxng",
		query: input.query.trim(),
		requested_engines: engines ?? "server defaults",
		retrieved_at: new Date().toISOString(),
		results,
		unavailable_engines: (payload.unresponsive_engines ?? [])
			.slice(0, 10)
			.map((engine) => clean(JSON.stringify(engine), 150)),
		note: "Snippets are leads. Load relevant URLs with load_web_page, search the document, then read selected lines and cite source URLs. No automatic engine fallback.",
	};
	while (JSON.stringify(result).length > MAX_OUTPUT && results.length)
		results.pop();
	if (!results.length)
		result.note =
			"No results returned within the output budget. Refine the query; do not invent results or automatically switch providers.";
	return result;
}

const plugin = createWebProviderPlugin({
	id: "searxng",
	isConfigured: async () => {
		try {
			await readSearxngSettings();
			return true;
		} catch {
			return false;
		}
	},
	search: async (
		input: WebSearchInput,
		context: AgentToolContext,
	): Promise<WebSearchResponse> => {
		if (input.recencyDays || input.country)
			throw new Error(
				"This SearXNG adapter does not support recencyDays or country; use language and precise query terms instead",
			);
		const query = input.domains?.length
			? `${input.query} (${input.domains
					.map((domain) => {
						if (!/^[a-zA-Z0-9.-]+$/.test(domain))
							throw new Error("Invalid search domain");
						return `site:${domain}`;
					})
					.join(" OR ")})`
			: input.query;
		return searchSearxng(
			{ query, max_results: input.limit, language: input.language },
			await readSearxngSettings(),
			context.signal,
		);
	},
});

plugin.name = "searxng-search";
export default plugin;
