import { createHash } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools } from "./index";
import {
	type Download,
	downloadWebPage,
	extractWebHtml,
	inspectWebDocument,
	isPublicAddress,
	readWebDocument,
	saveWebDocument,
	validateWebUrl,
	WEB_LIMITS,
	type WebDocument,
} from "./web-document";
import { createWebPageExecutor, createWebPageTools } from "./web-pages";

const context: AgentToolContext = { agentId: "test", iteration: 0 };
const dirs: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "cline-web-test-"));
	dirs.push(path);
	return path;
}
function html(text: string): Download {
	return {
		bytes: Buffer.from(text),
		text,
		mime: "text/html",
		url: "https://example.com/manual",
		requested_url: "https://example.com/manual",
	};
}
const workerPath = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../dist/extensions/web-page-worker.mjs",
);

describe("bounded web documents", () => {
	it("extracts article text, headings and navigable links without scripts or navigation chrome", () => {
		const page = html(
			`<title>Manual</title><nav>noise</nav><main><h1>Authentication</h1><p>${"Useful documentation. ".repeat(15)}<a href="/api">API</a></p><script>secret()</script></main>`,
		);
		const extracted = extractWebHtml(page);
		expect(extracted.title).toBe("Manual");
		expect(extracted.headings).toEqual(["Authentication"]);
		expect(extracted.links).toEqual(["https://example.com/api"]);
		expect(extracted.lines.join("\n")).toContain("https://example.com/api");
		expect(extracted.lines.join("\n")).not.toMatch(/noise|secret\(\)/);
	});
	it("rejects challenge pages instead of saving them as evidence", () => {
		expect(() =>
			extractWebHtml(
				html("<title>Just a moment...</title>checking your browser"),
			),
		).toThrow("resource could not be retrieved");
	});
	it("persists source and extracted files and opens the handle after a fresh cache read", async () => {
		const cache = await directory(),
			page = html("<h1>Manual</h1><p>Token authentication documentation.</p>");
		const receipt = (await saveWebDocument(
			cache,
			page,
			extractWebHtml(page),
		)) as {
			document_id: string;
			text_path: string;
			source_path: string;
			links_path: string;
		};
		expect(await readFile(receipt.source_path, "utf8")).toBe(page.text);
		expect(await readFile(receipt.text_path, "utf8")).toContain(
			"Token authentication",
		);
		expect(JSON.parse(await readFile(receipt.links_path, "utf8"))).toEqual([]);
		const saved = await readWebDocument(cache, receipt.document_id);
		expect(saved.sha256).toBe(
			createHash("sha256").update(page.bytes).digest("hex"),
		);
		expect(
			inspectWebDocument(saved, "search", { query: "authentication" }),
		).toMatchObject({ url: page.url, matching_lines: 1 });
	});
	it("bounds repeated reads and search passages and preserves PDF page references", () => {
		const doc: WebDocument = {
			document_id: "a".repeat(32),
			url: "https://example.com/manual.pdf",
			requested_url: "https://example.com/manual.pdf",
			title: "Manual",
			fetched_at: Date.now(),
			sha256: "hash",
			content_type: "application/pdf",
			bytes: 100,
			headings: [],
			lines: Array.from(
				{ length: 100 },
				(_, i) => `Authentication ${i} ${"x".repeat(220)}`,
			),
			page_count: 2,
			page_ranges: [
				{ page: 1, start_line: 1, end_line: 50 },
				{ page: 2, start_line: 51, end_line: 100 },
			],
		};
		const first = inspectWebDocument(doc, "read", {
			start_line: 51,
			line_count: 80,
		}) as { lines: { page: number }[]; next_line: number };
		expect(first.lines[0]?.page).toBe(2);
		expect(first.next_line).toBeGreaterThan(51);
		expect(JSON.stringify(first).length).toBeLessThanOrEqual(WEB_LIMITS.output);
		const search = inspectWebDocument(doc, "search", {
			query: "authentication",
			offset: 0,
		}) as { next_offset: number; passages: unknown[] };
		expect(search.passages.length).toBeGreaterThan(0);
		expect(search.next_offset).toBeGreaterThan(0);
		expect(JSON.stringify(search).length).toBeLessThanOrEqual(
			WEB_LIMITS.output,
		);
	});
	it("rejects expired handles and symlinked cache documents", async () => {
		const cache = await directory(),
			page = html("<p>Saved page</p>");
		const receipt = (await saveWebDocument(
			cache,
			page,
			extractWebHtml(page),
		)) as { document_id: string };
		const path = join(cache, receipt.document_id, "document.json");
		const doc = JSON.parse(await readFile(path, "utf8"));
		doc.fetched_at = Date.now() - WEB_LIMITS.ttl - 1;
		await writeFile(path, JSON.stringify(doc));
		await expect(readWebDocument(cache, receipt.document_id)).rejects.toThrow(
			"expired",
		);
		await rm(path);
		await symlink(join(cache, "elsewhere"), path);
		await expect(readWebDocument(cache, receipt.document_id)).rejects.toThrow();
		await expect(readWebDocument(cache, "../../other")).rejects.toThrow(
			"Invalid document_id",
		);
	});
});

describe("web URL and download policy", () => {
	it.each([
		"127.0.0.1",
		"10.0.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"::1",
		"::ffff:127.0.0.1",
		"fc00::1",
		"fe80::1",
		"224.0.0.1",
	])("rejects non-public address %s", (address) =>
		expect(isPublicAddress(address)).toBe(false));
	it("pins a public DNS answer and rejects mixed public/private answers", async () => {
		const good = { address: "93.184.216.34", family: 4 };
		await expect(
			validateWebUrl("https://example.com", async () => [good]),
		).resolves.toMatchObject({ address: good });
		await expect(
			validateWebUrl("https://example.com", async () => [
				good,
				{ address: "10.0.0.1", family: 4 },
			]),
		).rejects.toThrow("Only public");
		await expect(
			validateWebUrl("file:///tmp/file", async () => [good]),
		).rejects.toThrow("HTTP(S)");
		await expect(
			validateWebUrl("https://user:password@example.com", async () => [good]),
		).rejects.toThrow("without credentials");
	});
	it("follows a bounded redirect chain and preserves original/final source URLs", async () => {
		const transport = vi
			.fn()
			.mockResolvedValueOnce({ status: 302, location: "/final" })
			.mockResolvedValueOnce({
				status: 200,
				mime: "text/plain",
				charset: "utf-8",
				bytes: Buffer.from("Evidence"),
			});
		const page = await downloadWebPage("https://example.com/start", transport);
		expect(page).toMatchObject({
			requested_url: "https://example.com/start",
			url: "https://example.com/final",
			text: "Evidence",
		});
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it("does not retry denied resources", async () => {
		const transport = vi.fn().mockResolvedValue({ status: 403 });
		await expect(
			downloadWebPage("https://example.com/blocked", transport),
		).rejects.toThrow("distinct source");
		expect(transport).toHaveBeenCalledTimes(1);
	});
});

describe("shared tool execution and provider acquisition", () => {
	it("replaces whole-page fetch with load, search and selected read tools", () => {
		const names = createBuiltinTools({ cwd: "/workspace" }).map(
			(tool) => tool.name,
		);
		expect(names).not.toContain("fetch_web_content");
		expect(names).toEqual(
			expect.arrayContaining([
				"load_web_page",
				"search_web_page",
				"read_web_page_content",
			]),
		);
	});
	it("uses one shared document workflow for a supplied acquisition provider and across executor restarts", async () => {
		const cacheDirectory = await directory(),
			page = html(
				"<main><h1>Authentication</h1><p>Use a bearer token.</p><a href='/next'>Next</a></main>",
			);
		const acquirePage = vi.fn().mockResolvedValue({
			bytes: page.bytes,
			url: page.url,
			contentType: page.mime,
		});
		const tools = createWebPageTools(
			createWebPageExecutor({ cacheDirectory, workerPath, acquirePage }),
			"/workspace",
		);
		const receipt = (await tools
			.find((tool) => tool.name === "load_web_page")!
			.execute({ url: page.url }, context)) as { document_id: string };
		expect(acquirePage).toHaveBeenCalledTimes(1);
		const restarted = createWebPageTools(
			createWebPageExecutor({ cacheDirectory, workerPath }),
			"/workspace",
		);
		const search = (await restarted
			.find((tool) => tool.name === "search_web_page")!
			.execute(
				{ document_id: receipt.document_id, query: "bearer" },
				context,
			)) as { passages: { match_line: number }[] };
		expect(search.passages.length).toBe(1);
		const read = await restarted
			.find((tool) => tool.name === "read_web_page_content")!
			.execute(
				{
					document_id: receipt.document_id,
					start_line: search.passages[0]!.match_line,
					line_count: 2,
				},
				context,
			);
		expect(JSON.stringify(read)).toContain("bearer token");
		expect(JSON.stringify(read).length).toBeLessThanOrEqual(6500);
		const other = createWebPageTools(
			createWebPageExecutor({ cacheDirectory, workerPath }),
			"/another-workspace",
		);
		await expect(
			other[2]!.execute({ document_id: receipt.document_id }, context),
		).rejects.toThrow();
	});
	it("extracts PDF text through the same provider workflow with one-based page references", async () => {
		const stream =
			"BT /F1 12 Tf 72 720 Td (Authentication uses bearer tokens.) Tj ET";
		const objects = [
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
			"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		];
		let pdf = "%PDF-1.4\n";
		const offsets = [0];
		objects.forEach((object, i) => {
			offsets.push(Buffer.byteLength(pdf));
			pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
		});
		const xref = Buffer.byteLength(pdf);
		pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
			.slice(1)
			.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
			.join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
		const cacheDirectory = await directory();
		const packagedWorker = join(cacheDirectory, "web-page-worker.mjs");
		await copyFile(workerPath, packagedWorker);
		const execute = createWebPageExecutor({
			cacheDirectory,
			workerPath: packagedWorker,
			acquirePage: async (url) => ({
				bytes: Buffer.from(pdf),
				url,
				contentType: "application/pdf",
			}),
		});
		const receipt = (await execute(
			"load",
			{ url: "https://93.184.216.34/manual.pdf" },
			context,
		)) as { document_id: string; page_count: number };
		expect(receipt.page_count).toBe(1);
		const read = await execute(
			"read",
			{ document_id: receipt.document_id },
			context,
		);
		expect(read).toMatchObject({
			lines: [{ page: 1, text: "Authentication uses bearer tokens." }],
		});
	});

	it("rejects a private destination before invoking a custom acquisition provider", async () => {
		const acquirePage = vi.fn();
		const execute = createWebPageExecutor({ workerPath, acquirePage });
		await expect(
			execute("load", { url: "http://127.0.0.1/private" }, context),
		).rejects.toThrow("Only public");
		expect(acquirePage).not.toHaveBeenCalled();
	});

	it("cancels provider acquisition and enforces a deadline even when a provider fails to resolve", async () => {
		let acquisitionSignal: AbortSignal | undefined;
		const execute = createWebPageExecutor({
			workerPath,
			loadTimeoutMs: 25,
			acquirePage: async (_url, ctx) => {
				acquisitionSignal = ctx.signal;
				return new Promise(() => {});
			},
		});
		await expect(
			execute("load", { url: "https://example.com" }, context),
		).rejects.toThrow("exceeded");
		expect(acquisitionSignal?.aborted).toBe(true);
	});
	it("terminates CPU-bound regular expressions in the worker", async () => {
		const cacheDirectory = await directory(),
			scoped = join(
				cacheDirectory,
				createHash("sha256")
					.update(resolve("/workspace"))
					.digest("hex")
					.slice(0, 32),
			);
		const page = html("a".repeat(240) + "!");
		const receipt = (await saveWebDocument(scoped, page, {
			title: "Regex fixture",
			lines: [page.text],
			headings: [],
		})) as { document_id: string };
		const execute = createWebPageExecutor({
			cacheDirectory,
			workerPath,
			inspectTimeoutMs: 150,
		});
		await expect(
			execute(
				"search",
				{ document_id: receipt.document_id, query: "(a+)+$", regex: true },
				{ ...context, metadata: { cwd: "/workspace" } },
			),
		).rejects.toThrow("exceeded");
	});
});
