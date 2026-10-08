export const REASONING_PREVIEW_MAX_CHARS = 2048;
export const REASONING_PREVIEW_MAX_LINES = 8;
export const REASONING_PREVIEW_INTERVAL_MS = 100;

/** Bound work even for a single very long line or chunk. */
export function reasoningPreview(text: string): string {
	return text
		.slice(-REASONING_PREVIEW_MAX_CHARS)
		.split("\n")
		.slice(-REASONING_PREVIEW_MAX_LINES)
		.join("\n");
}

/** Full text is joined once at completion; React only receives a bounded tail. */
export class ReasoningStreamBuffer {
	private chunks: string[] = [];
	private tail = "";
	private active = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly publish: (preview: string) => void) {}

	start(chunk: string): string {
		this.dispose();
		this.active = true;
		this.chunks = [chunk];
		this.tail = reasoningPreview(chunk);
		return this.tail;
	}

	append(chunk: string): void {
		if (!this.active || !chunk) return;
		this.chunks.push(chunk);
		this.tail = reasoningPreview(
			this.tail + chunk.slice(-REASONING_PREVIEW_MAX_CHARS),
		);
		if (this.timer !== undefined) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.active) this.publish(this.tail);
		}, REASONING_PREVIEW_INTERVAL_MS);
	}

	finish(): string | undefined {
		if (!this.active) return undefined;
		const full = this.chunks.join("");
		this.dispose();
		return full;
	}

	dispose(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.active = false;
		this.chunks = [];
		this.tail = "";
	}
}
