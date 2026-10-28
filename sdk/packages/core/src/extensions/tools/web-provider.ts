import {
	type AgentConfig,
	type AgentToolContext,
	createTool,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import {
	isModelToolEnabledGlobally,
	readGlobalSettings,
} from "../../services/global-settings";
import {
	createWebPageExecutor,
	createWebPageTools,
	type WebPageAcquirer,
} from "./web-pages";

type AgentPlugin = NonNullable<AgentConfig["extensions"]>[number];

/** The same public schema is used by every plugin-backed search provider. */
export const WebSearchInputSchema = z
	.object({
		query: z.string().trim().min(1).max(500),
		limit: z.number().int().min(1).max(5).default(3),
		domains: z.array(z.string().min(1).max(253)).max(10).optional(),
		recencyDays: z.number().int().positive().optional(),
		country: z
			.string()
			.regex(/^[a-zA-Z]{2}$/)
			.optional(),
		language: z
			.string()
			.regex(/^(?:all|[a-zA-Z]{2}(?:[-_][a-zA-Z]{2})?)$/)
			.optional(),
	})
	.strict();
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;
export interface WebSearchResponse {
	results: {
		title: string;
		url: string;
		snippet?: string;
		publishedAt?: string;
		engines?: string[];
	}[];
	note?: string;
}
export interface WebProviderOptions {
	id: string;
	/** Check credentials/connection settings locally; never make an inference request during setup. */
	isConfigured?: () => boolean | Promise<boolean>;
	search?: (
		input: WebSearchInput,
		context: AgentToolContext,
	) => Promise<WebSearchResponse>;
	/** Supply bytes and provenance only. Core still owns extraction, storage and navigation. */
	loadPage?: WebPageAcquirer;
}

export function readWebSearchProvider(): string {
	return readGlobalSettings().webSearchProvider ?? "native";
}
export function readWebPageProvider(): string {
	return readGlobalSettings().webPageProvider ?? "http";
}

function normalizeSearch(
	response: WebSearchResponse,
	provider: string,
	query: string,
	limit: number,
) {
	const results = response.results
		.flatMap((result) => {
			try {
				const url = new URL(result.url);
				if (
					!["http:", "https:"].includes(url.protocol) ||
					url.username ||
					url.password ||
					result.url.length > 1200
				)
					return [];
			} catch {
				return [];
			}
			return [
				{
					title: result.title.slice(0, 180),
					url: result.url,
					snippet: result.snippet?.slice(0, 550),
					publishedAt: result.publishedAt?.slice(0, 80),
					engines: result.engines
						?.slice(0, 5)
						.map((engine) => engine.slice(0, 60)),
				},
			];
		})
		.slice(0, limit);
	const output = {
		provider,
		query,
		results,
		retrieved_at: new Date().toISOString(),
		note:
			response.note?.slice(0, 500) ??
			"Load relevant URLs, search the saved documents and read selected passages to verify claims. Cite source URLs.",
	};
	while (JSON.stringify(output).length > 6500 && results.length) results.pop();
	return output;
}

/** Providers contribute only acquisition. Public tool names and document behavior belong to core. */
export function createWebProviderPlugin(
	options: WebProviderOptions,
): AgentPlugin {
	if (
		!/^[a-z][a-z0-9-]*$/.test(options.id) ||
		["native", "http"].includes(options.id)
	)
		throw new Error("Use a distinct web provider id");
	return {
		name: `${options.id}-web`,
		manifest: { capabilities: ["tools"] },
		async setup(api, ctx) {
			const searchSelected =
				readWebSearchProvider() === options.id &&
				isModelToolEnabledGlobally("web_search");
			const pageSelected = readWebPageProvider() === options.id;
			if (!searchSelected && !pageSelected) return;
			if (options.isConfigured && !(await options.isConfigured())) {
				ctx.logger?.log(
					`Web provider ${options.id} is selected but not configured; no tools were registered and no fallback was selected.`,
				);
				return;
			}
			if (searchSelected && options.search)
				api.registerTool(
					createTool({
						name: "web_search",
						description:
							"Search the public web for current, unfamiliar or disputed facts. Prefer primary sources and keep queries free of private content. Snippets are leads: load relevant pages with load_web_page, find passages with search_web_page, and read selected lines with read_web_page_content to verify claims and cite source URLs.",
						inputSchema: zodToJsonSchema(WebSearchInputSchema),
						timeoutMs: 30_000,
						retryable: false,
						execute: async (input: unknown, context: AgentToolContext) => {
							const parsed = WebSearchInputSchema.parse(input);
							return normalizeSearch(
								await options.search!(parsed, context),
								options.id,
								parsed.query,
								parsed.limit,
							);
						},
					}),
				);
			if (pageSelected && options.loadPage) {
				const load = createWebPageTools(
					createWebPageExecutor({ acquirePage: options.loadPage }),
					ctx.cwd,
				).find((tool) => tool.name === "load_web_page");
				if (load) api.registerTool(load);
			}
		},
	};
}
