/**
 * Web Search Plugin Example
 *
 * Registers a `web_search` tool backed by Exa.
 *
 * Select webSearchProvider: "exa" in Cline global settings.
 * CLI usage:
 *   cline plugin install https://github.com/cline/cline/blob/main/sdk/examples/plugins/web-search.ts --cwd .
 *   EXA_API_KEY=... cline "Search the web for recent TypeScript 6 updates"
 *
 * Provider key:
 *   EXA_API_KEY              Enables Exa search. A separate model provider key
 *                            is still required for CLI inference.
 */

import { createWebProviderPlugin } from "@cline/core";

export interface WebSearchInput {
	query: string;
	limit?: number;
	domains?: string[];
	recencyDays?: number;
	country?: string;
}

export interface WebSearchResult {
	title: string;
	url: string;
	snippet?: string;
	publishedAt?: string;
	author?: string;
	score?: number;
	source: "exa";
}

export interface WebSearchOutput {
	provider: "exa";
	query: string;
	results: WebSearchResult[];
	requestId?: string;
}

interface ExaSearchResult {
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string;
	score?: number;
	text?: string;
	highlights?: string[];
	summary?: string;
}

interface ExaSearchResponse {
	requestId?: string;
	results?: ExaSearchResult[];
	error?: string;
}

const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 10;
const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";

function env(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function clampResultLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) {
		return DEFAULT_RESULT_LIMIT;
	}
	const integer = Math.trunc(limit);
	return Math.min(Math.max(integer, 1), MAX_RESULT_LIMIT);
}

function normalizeDomains(domains: string[] | undefined): string[] | undefined {
	const normalized = domains
		?.map((domain) => domain.trim().replace(/^https?:\/\//, ""))
		.map((domain) => domain.replace(/\/.*$/, ""))
		.filter(Boolean);
	return normalized && normalized.length > 0
		? [...new Set(normalized)]
		: undefined;
}

function isoDateDaysAgo(days: number | undefined): string | undefined {
	if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
		return undefined;
	}
	const date = new Date();
	date.setUTCDate(date.getUTCDate() - Math.trunc(days));
	return date.toISOString();
}

function truncateSnippet(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return undefined;
	}
	return normalized.length > 800
		? `${normalized.slice(0, 797).trimEnd()}...`
		: normalized;
}

function extractErrorMessage(body: unknown): string | undefined {
	if (!body || typeof body !== "object") {
		return undefined;
	}
	const record = body as Record<string, unknown>;
	for (const key of ["error", "message", "detail"] as const) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return undefined;
}

function hasResultUrl(
	result: ExaSearchResult,
): result is ExaSearchResult & { url: string } {
	return typeof result.url === "string" && result.url.trim().length > 0;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
	const text = await response.text();
	let body: unknown = {};
	try {
		body = text ? (JSON.parse(text) as unknown) : {};
	} catch {
		if (!response.ok) {
			throw new Error(
				`HTTP ${response.status}: ${text || response.statusText}`,
			);
		}
		throw new Error("Search provider returned invalid JSON");
	}

	if (!response.ok) {
		const message = extractErrorMessage(body) ?? (text || response.statusText);
		throw new Error(`HTTP ${response.status}: ${message}`);
	}

	return body as T;
}

function resolveExaApiKey(): string {
	const exaApiKey = env("EXA_API_KEY");
	if (!exaApiKey) {
		throw new Error("Set EXA_API_KEY to use web_search");
	}
	return exaApiKey;
}

async function searchExa(
	input: WebSearchInput,
	apiKey: string,
	limit: number,
	domains: string[] | undefined,
	signal?: AbortSignal,
): Promise<WebSearchOutput> {
	const body: Record<string, unknown> = {
		query: input.query,
		numResults: limit,
		contents: {
			highlights: true,
		},
	};
	if (domains) {
		body.includeDomains = domains;
	}
	const startPublishedDate = isoDateDaysAgo(input.recencyDays);
	if (startPublishedDate) {
		body.startPublishedDate = startPublishedDate;
	}
	if (input.country) {
		body.userLocation = input.country.toLowerCase();
	}

	const response = await fetch(EXA_SEARCH_ENDPOINT, {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(25_000)])
			: AbortSignal.timeout(25_000),
	});
	const json = await readJsonResponse<ExaSearchResponse>(response);

	if (json.error) {
		throw new Error(json.error);
	}

	return {
		provider: "exa",
		query: input.query,
		requestId: json.requestId,
		results: (json.results ?? [])
			.filter(hasResultUrl)
			.slice(0, limit)
			.map((result) => ({
				title: result.title || result.url || "Untitled",
				url: result.url,
				snippet: truncateSnippet(
					result.highlights?.join("\n") ?? result.summary ?? result.text,
				),
				publishedAt: result.publishedDate,
				author: result.author,
				score: result.score,
				source: "exa",
			})),
	};
}

export async function searchWeb(
	input: WebSearchInput,
	signal?: AbortSignal,
): Promise<WebSearchOutput> {
	if (!input.query || !input.query.trim()) {
		throw new Error("query is required");
	}

	const limit = clampResultLimit(input.limit);
	const domains = normalizeDomains(input.domains);
	const apiKey = resolveExaApiKey();

	return searchExa(input, apiKey, limit, domains, signal);
}

const plugin = createWebProviderPlugin({
	id: "exa",
	isConfigured: () => !!env("EXA_API_KEY"),
	search: async (input, context) =>
		searchWeb(
			{
				query: input.query,
				limit: input.limit,
				domains: input.domains,
				recencyDays: input.recencyDays,
				country: input.country,
			},
			context.signal,
		),
});

// Keep the existing installed plugin identity and its policy preferences.
plugin.name = "web-search";

export { plugin };
export default plugin;
