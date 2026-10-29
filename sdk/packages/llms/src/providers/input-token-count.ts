import type { RequestInputTokenCount } from "@cline/shared";
import {
	countLocalInferenceRequest,
	type NativeCountOptions,
	normalizeLocalInferenceRequest,
} from "./local-inference";

export function parseInputTokenCount(value: unknown): RequestInputTokenCount {
	if (!value || typeof value !== "object")
		throw new Error("Invalid input token count response");
	const v = value as RequestInputTokenCount;
	for (const key of [
		"inputTokens",
		"contextWindow",
		"maxInputTokens",
		"maxOutputTokens",
		"compactionBufferTokens",
		"serverBoundaryTokens",
	] as const) {
		if (
			!Number.isSafeInteger(v[key]) ||
			v[key] <
				(key === "inputTokens" ||
				key === "compactionBufferTokens" ||
				key === "serverBoundaryTokens"
					? 0
					: 1)
		)
			throw new Error(`Invalid input token count field: ${key}`);
	}
	if (
		(v.source !== "tokenized" && v.source !== "bounded") ||
		!v.fingerprint ||
		!v.budgetRevision
	)
		throw new Error("Input token counter did not identify its measurement");
	if (
		v.maxInputTokens + v.maxOutputTokens + v.serverBoundaryTokens >
		v.contextWindow
	)
		throw new Error("Input token counter returned inconsistent limits");
	return v;
}

/** Feed the SDK's real serialized request into a count-only endpoint. */
export function createInputTokenCountFetch(
	delegate: typeof fetch,
	endpoint: string,
	countOnly: boolean,
	onMeasurement: (count: RequestInputTokenCount) => void,
	native?: NativeCountOptions,
): typeof fetch {
	const countUrl = new URL(endpoint);
	return (async (input, init) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(String(input), init);
		if (countOnly || native) {
			const url = new URL(request.url);
			if (
				url.origin !== countUrl.origin ||
				!url.pathname.endsWith("/chat/completions")
			)
				throw new Error(
					"Count-only transport refused an unexpected inference endpoint",
				);
		}
		const normalized = native
			? normalizeLocalInferenceRequest(
					JSON.parse(await request.clone().text()),
					native.engine,
					native.settings,
					native.continueAssistantMessage,
				)
			: undefined;
		const nativeCount = native
			? await countLocalInferenceRequest(
					delegate,
					normalized!,
					request.headers,
					request.signal,
					native,
				)
			: undefined;
		if (nativeCount && !countOnly) onMeasurement(nativeCount);
		if (countOnly) {
			const response = nativeCount
				? new Response(JSON.stringify(nativeCount), {
						headers: { "Content-Type": "application/json" },
					})
				: await delegate(countUrl, {
						method: "POST",
						headers: request.headers,
						body: await request.text(),
						signal: request.signal,
					});
			if (!response.ok)
				throw new Error(
					`Input token counting unavailable (${response.status}): ${(await response.text()).slice(0, 1500)}`,
				);
			const count = parseInputTokenCount(await response.json());
			onMeasurement(count);
			// Complete serialization without any inference, tools, or synthetic usage.
			const chunk = {
				id: "input-token-count",
				object: "chat.completion.chunk",
				created: 0,
				model: "count-only",
				choices: [
					{ index: 0, delta: { content: "counted" }, finish_reason: null },
				],
			};
			const done = {
				...chunk,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			};
			return new Response(
				`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}
		request.signal.throwIfAborted();
		if (nativeCount && nativeCount.inputTokens > nativeCount.maxInputTokens)
			throw new Error(
				`Context window exceeded: measured input ${nativeCount.inputTokens} exceeds allowance ${nativeCount.maxInputTokens}`,
			);
		const response = normalized
			? await delegate(
					new Request(request, { body: JSON.stringify(normalized) }),
				)
			: await delegate(input, init);
		const count = response.headers.get("X-Cline-Input-Token-Count");
		if (count && !nativeCount)
			onMeasurement(parseInputTokenCount(JSON.parse(count)));
		return response;
	}) as typeof fetch;
}
