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

export interface TokenEstimatedRequest {
	systemPrompt?: string;
	messages: readonly unknown[];
	tools?: readonly unknown[];
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
	let serialized: string;
	try {
		serialized = JSON.stringify({
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
		});
	} catch {
		serialized = [
			safeStringify(request.systemPrompt),
			safeStringify(request.messages),
			safeStringify(request.tools),
		].join("\n");
	}
	// Deliberately over-estimate slightly to leave room for provider formatting,
	// tool schema overhead, and tokenizer drift.
	return estimateTokens(serialized.length);
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
