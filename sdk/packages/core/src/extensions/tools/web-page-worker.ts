import { parentPort, workerData } from "node:worker_threads";
// Static import lets the worker bundle include the parser and its fake worker.
import pdfjs from "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js";
import {
	type Download,
	downloadWebPage,
	extractWebHtml,
	inspectWebDocument,
	readWebDocument,
	saveWebDocument,
	validateWebUrl,
	WEB_LIMITS,
	WebResourceError,
	wrapWebLines,
} from "./web-document";
import {
	LoadWebPageSchema,
	ReadWebPageSchema,
	SearchWebPageSchema,
} from "./web-page-schemas";

async function extractPdf(page: Download) {
	// This parser version reads these flags from PDFJS, not per-document options.
	pdfjs.PDFJS.disableWorker = true;
	pdfjs.PDFJS.disableFontFace = true;
	pdfjs.PDFJS.isEvalSupported = false;
	const pdf = await pdfjs.getDocument({
		data: new Uint8Array(page.bytes),
		isEvalSupported: false,
		disableFontFace: true,
	});
	try {
		if (pdf.numPages > WEB_LIMITS.pages)
			throw new Error("PDF exceeds the 2,000-page extraction limit");
		const lines: string[] = [],
			page_ranges: { page: number; start_line: number; end_line: number }[] =
				[];
		let characters = 0;
		for (let number = 1; number <= pdf.numPages; number++) {
			const page = await pdf.getPage(number),
				content = await page.getTextContent({ normalizeWhitespace: true });
			let text = "",
				y: number | undefined;
			for (const item of content.items) {
				if (y !== undefined && y !== item.transform[5]) text += "\n";
				text += `${item.str} `;
				y = item.transform[5];
			}
			characters += text.length;
			if (characters > WEB_LIMITS.characters)
				throw new Error(
					"PDF exceeds the 10 million character extraction limit",
				);
			const start = lines.length + 1;
			lines.push(...wrapWebLines(text));
			if (lines.length >= start)
				page_ranges.push({
					page: number,
					start_line: start,
					end_line: lines.length,
				});
			page.cleanup();
		}
		const metadata = await pdf.getMetadata().catch(() => undefined);
		return {
			lines,
			title: String(
				metadata?.info?.Title ??
					new URL(page.url).pathname.split("/").pop() ??
					"PDF",
			).slice(0, 200),
			headings: [],
			page_count: pdf.numPages,
			page_ranges,
		};
	} finally {
		await pdf.destroy();
	}
}

async function main() {
	const { operation, input, cache, acquired } = workerData;
	if (operation === "load") {
		const { url } = LoadWebPageSchema.parse(input);
		let page: Download;
		if (acquired) {
			await validateWebUrl(url);
			await validateWebUrl(acquired.url);
			const bytes = Buffer.from(acquired.bytes);
			if (bytes.length > WEB_LIMITS.bytes)
				throw new Error("Page exceeds the 32 MiB download limit");
			const mime =
				bytes.subarray(0, 5).toString() === "%PDF-"
					? "application/pdf"
					: String(acquired.contentType).split(";")[0].trim().toLowerCase();
			if (
				![
					"application/pdf",
					"text/html",
					"application/xhtml+xml",
					"text/plain",
					"text/markdown",
					"application/json",
				].includes(mime)
			)
				throw new Error("Unsupported provider content type");
			page = {
				bytes,
				mime,
				url: acquired.url,
				requested_url: url,
				text: mime === "application/pdf" ? "" : bytes.toString("utf8"),
			};
		} else page = await downloadWebPage(url);
		const content =
			page.mime === "application/pdf"
				? await extractPdf(page)
				: ["text/html", "application/xhtml+xml"].includes(page.mime)
					? extractWebHtml(page)
					: { lines: wrapWebLines(page.text), title: "", headings: [] };
		return saveWebDocument(cache, page, content);
	}
	const parsed =
		operation === "search"
			? SearchWebPageSchema.parse(input)
			: ReadWebPageSchema.parse(input);
	return inspectWebDocument(
		await readWebDocument(cache, parsed.document_id),
		operation,
		parsed,
	);
}
main()
	.then((result) => parentPort?.postMessage({ result }))
	.catch((error: unknown) => {
		if (error instanceof WebResourceError)
			parentPort?.postMessage({
				result: {
					status: "error",
					code: "WEB_RETRIEVAL_FAILED",
					url: error.url,
					reason: error.reason,
					http_status: error.httpStatus,
					next_step: error.message,
				},
			});
		else
			parentPort?.postMessage({
				error:
					error instanceof Error
						? error.message.slice(0, 350)
						: "Web operation failed",
			});
	});
