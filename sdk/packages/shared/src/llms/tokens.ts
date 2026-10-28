/**
 * Conservative chars-per-token approximation used for compaction triggering
 * and request-size diagnostics. Uses 3 chars/token (slightly over-counts vs
 * the conventional 4) so trigger thresholds fire before provider rejection
 * rather than after.
 */

export const CHARS_PER_TOKEN = 3;

export function estimateTokens(chars: number): number {
	return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

/**
 * Flat per-image token cost used in place of the char-based estimate for an
 * image block's base64 payload. Real vision-model costs depend on pixel
 * dimensions, not encoded byte size, and vary with each backend processor.
 * The fallback reserves 2,048 tokens per image independently of payload length;
 * this is an estimate rather than a universal image-token ceiling.
 */
export const ESTIMATED_TOKENS_PER_IMAGE = 2_048;

export interface TokenEstimatedRequest {
	systemPrompt?: string;
	messages: readonly unknown[];
	tools?: readonly unknown[];
}

/**
 * Build a JSON.stringify replacer that blanks an image node's base64
 * payload wherever it's nested in the serialized value, so it's never
 * billed at CHARS_PER_TOKEN. Two image shapes reach this replacer:
 * `ImageContent { type: "image", data: string }` (compaction's
 * `MessageWithMetadata`) and `AgentImagePart { type: "image", image:
 * string | Uint8Array | ArrayBuffer | URL }` (the gateway's
 * `AgentMessage`). Returns the replacer alongside an `imageCount`
 * accessor so the caller can add a flat per-image token cost back in
 * afterwards.
 */
export function createImageAwareReplacer(): {
	replacer: (key: string, value: unknown) => unknown;
	imageCount: () => number;
} {
	let count = 0;
	const replacer = (_key: string, value: unknown): unknown => {
		if (
			value === null ||
			typeof value !== "object" ||
			(value as { type?: unknown }).type !== "image"
		) {
			return value;
		}
		const record = value as Record<string, unknown>;
		if (typeof record.data === "string") {
			count += 1;
			return { ...record, data: "" };
		}
		if ("image" in record) {
			count += 1;
			return { ...record, image: "" };
		}
		return value;
	};
	return { replacer, imageCount: () => count };
}

function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_key, nestedValue: unknown) => {
				if (typeof nestedValue === "bigint") {
					return nestedValue.toString();
				}
				if (typeof nestedValue !== "object" || nestedValue === null) {
					return nestedValue;
				}
				if (seen.has(nestedValue)) {
					return "[Circular]";
				}
				seen.add(nestedValue);
				return nestedValue;
			}) ?? ""
		);
	} catch {
		return String(value ?? "");
	}
}

/**
 * Estimate the complete provider request payload so request execution and
 * pre-request policies use the same definition of input utilization.
 */
export function estimateRequestInputTokens(
	request: TokenEstimatedRequest,
): number {
	const { replacer, imageCount } = createImageAwareReplacer();
	let serialized: string;
	// Only trust imageCount() when the replacer-driven pass actually
	// finished. A mid-serialization throw (e.g. a BigInt elsewhere in the
	// payload) can leave it having already counted some images, and the
	// fallback below then re-serializes everything in full, including
	// their base64 payload. Capturing the count only on success avoids
	// billing those images once for their raw bytes and again for the
	// flat per-image estimate.
	let images = 0;
	try {
		serialized = JSON.stringify(
			{
				systemPrompt: request.systemPrompt,
				messages: request.messages.map((message) => {
					if (
						message &&
						typeof message === "object" &&
						"role" in message &&
						"content" in message
					) {
						const m = message as { role: unknown; content: unknown };
						return { role: m.role, content: m.content };
					}
					return message;
				}),
				tools: request.tools,
			},
			replacer,
		);
		images = imageCount();
	} catch {
		serialized = [
			safeStringify(request.systemPrompt),
			safeStringify(request.messages),
			safeStringify(request.tools),
		].join("\n");
	}
	// Deliberately over-estimate slightly to leave room for provider formatting,
	// tool schema overhead, and tokenizer drift.
	return (
		estimateTokens(serialized.length) + images * ESTIMATED_TOKENS_PER_IMAGE
	);
}

function isPositiveBudgetNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
/**
 * Resolve the model's usable prompt budget. A reported input limit is
 * authoritative but cannot exceed the context window. When the model only
 * reports a context window, retain a conservative margin for request overhead.
 */
export function resolveEffectiveMaxInputTokens(input: {
	maxInputTokens?: number;
	contextWindow?: number;
	maxOutputTokens?: number;
}): number | undefined {
	const contextWindow = isPositiveBudgetNumber(input.contextWindow)
		? input.contextWindow
		: undefined;
	const maxInputTokens = isPositiveBudgetNumber(input.maxInputTokens)
		? input.maxInputTokens
		: undefined;

	const output = isPositiveBudgetNumber(input.maxOutputTokens)
		? Math.floor(input.maxOutputTokens)
		: undefined;
	const available =
		contextWindow === undefined ? undefined : contextWindow - (output ?? 0);
	if (available !== undefined && available <= 0)
		throw new Error("Output allowance leaves no usable input capacity");
	if (maxInputTokens !== undefined) {
		return available === undefined
			? maxInputTokens
			: Math.min(maxInputTokens, available);
	}
	if (available !== undefined && output !== undefined) return available;

	return contextWindow === undefined ? undefined : contextWindow * 0.9;
}
