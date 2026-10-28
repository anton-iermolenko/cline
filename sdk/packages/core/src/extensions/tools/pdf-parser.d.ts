declare module "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js" {
	interface PdfPage {
		getTextContent(options: {
			normalizeWhitespace: boolean;
		}): Promise<{ items: { str: string; transform: number[] }[] }>;
		cleanup(): void;
	}
	interface PdfDocument {
		numPages: number;
		getPage(number: number): Promise<PdfPage>;
		getMetadata(): Promise<{ info?: { Title?: string } }>;
		destroy(): Promise<void>;
	}
	const pdfjs: {
		PDFJS: {
			disableWorker: boolean;
			disableFontFace: boolean;
			isEvalSupported: boolean;
		};
		getDocument(options: {
			data: Uint8Array;
			isEvalSupported: boolean;
			disableFontFace: boolean;
		}): Promise<PdfDocument>;
	};
	export default pdfjs;
}
