import { createHash } from "node:crypto";
import {
	estimateRequestInputTokens,
	type BasicLogger,
	type MessageWithMetadata,
	type RequestInputTokenCount,
} from "@cline/shared";

type EstimateMessageTokens = (message: MessageWithMetadata) => number;

/** Recognize image blocks, not arbitrary long strings or ordinary text files. */
function imageKey(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const block = value as Record<string, unknown>;
	if (!["image", "image_url", "input_image"].includes(String(block.type)))
		return undefined;
	const source = block.source as Record<string, unknown> | undefined;
	const imageUrl = block.image_url;
	let payload = block.data ?? source?.data;
	if (typeof payload !== "string") {
		payload =
			(typeof imageUrl === "string"
				? imageUrl
				: (imageUrl as Record<string, unknown> | undefined)?.url) ??
			block.url ??
			source?.url;
	}
	if (typeof payload !== "string") return undefined;
	const comma = payload.startsWith("data:image/") ? payload.indexOf(",") : -1;
	const normalized = comma >= 0 ? payload.slice(comma + 1) : payload;
	return createHash("sha256").update(normalized).digest("hex");
}

function imageCounts(value: unknown, counts = new Map<string, number>()) {
	const key = imageKey(value);
	if (key) {
		counts.set(key, (counts.get(key) ?? 0) + 1);
	} else if (Array.isArray(value)) {
		for (const child of value) imageCounts(child, counts);
	} else if (value && typeof value === "object") {
		for (const child of Object.values(value)) imageCounts(child, counts);
	}
	return counts;
}

/** Copy only for counting. Actual messages and image bytes are never modified. */
function selectImages(value: unknown, keep?: string): unknown {
	const key = imageKey(value);
	if (key) return key === keep ? value : undefined;
	if (Array.isArray(value))
		return value
			.map((child) => selectImages(child, keep))
			.filter((child) => child !== undefined);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.map(([name, child]) => [name, selectImages(child, keep)])
				.filter(([, child]) => child !== undefined),
		);
	return value;
}

function withoutImages(message: MessageWithMetadata, keep?: string) {
	return {
		...message,
		content: selectImages(message.content, keep),
	} as MessageWithMetadata;
}

export async function createMeasuredImageTokenEstimator(options: {
	messages: MessageWithMetadata[];
	apiMessages: MessageWithMetadata[];
	systemPrompt: string;
	tools: unknown[];
	measurement: RequestInputTokenCount;
	countRequest: (
		messages: MessageWithMetadata[],
	) => Promise<RequestInputTokenCount | undefined>;
	baseEstimateMessageTokens: EstimateMessageTokens;
	signal: AbortSignal;
	logger?: BasicLogger;
}): Promise<EstimateMessageTokens | undefined> {
	const occurrences = new Map<string, number>();
	for (const message of options.messages)
		imageCounts(message.content, occurrences);
	if (occurrences.size === 0) return undefined;
	options.signal.throwIfAborted();
	const textMessages = options.messages.map((m) => withoutImages(m));
	const textMeasurement = await options.countRequest(textMessages);
	options.signal.throwIfAborted();
	const sameBudget = (measurement: RequestInputTokenCount | undefined) =>
		measurement &&
		measurement.budgetRevision === options.measurement.budgetRevision &&
		measurement.maxInputTokens === options.measurement.maxInputTokens &&
		measurement.maxOutputTokens === options.measurement.maxOutputTokens;
	if (!sameBudget(textMeasurement))
		throw new Error(
			"Image token calibration lost its native counter or model budget; original context was preserved",
		);
	const imageTokens =
		options.measurement.inputTokens - textMeasurement!.inputTokens;
	if (imageTokens < 0) {
		options.logger?.log(
			"Image token calibration declined inconsistent counts",
			{
				severity: "warn",
				inputTokens: options.measurement.inputTokens,
				textOnlyInputTokens: textMeasurement!.inputTokens,
			},
		);
		return undefined;
	}
	const textEstimate = estimateRequestInputTokens({
		systemPrompt: options.systemPrompt,
		messages: options.apiMessages.map((m) => withoutImages(m)),
		tools: options.tools,
	});
	const textScale = textMeasurement!.inputTokens / Math.max(1, textEstimate);
	const imageWeights = new Map<string, number>();
	if (occurrences.size === 1) {
		const [key, count] = [...occurrences][0];
		imageWeights.set(key, imageTokens / count);
	} else {
		let total = 0;
		for (const [key, count] of occurrences) {
			options.signal.throwIfAborted();
			const measured = await options.countRequest(
				options.messages.map((m) => withoutImages(m, key)),
			);
			options.signal.throwIfAborted();
			if (!sameBudget(measured))
				throw new Error(
					"Image token calibration lost its native counter or model budget; original context was preserved",
				);
			const weight = Math.max(
				0,
				measured!.inputTokens - textMeasurement!.inputTokens,
			);
			imageWeights.set(key, weight / count);
			total += weight;
		}
		if (total === 0 && imageTokens > 0) return undefined;
		for (const [key, weight] of imageWeights)
			imageWeights.set(key, total > 0 ? (weight * imageTokens) / total : 0);
	}
	options.logger?.debug("Calibrated image retention tokens", {
		uniqueImages: occurrences.size,
		imageOccurrences: [...occurrences.values()].reduce((a, b) => a + b, 0),
		imageTokens,
		textOnlyInputTokens: textMeasurement!.inputTokens,
		textScale,
	});
	const cache = new WeakMap<object, number>();
	return (message) => {
		const cached = cache.get(message);
		if (cached !== undefined) return cached;
		const images = imageCounts(message.content);
		let visionTokens = 0;
		for (const [key, count] of images) {
			const cost = imageWeights.get(key);
			// A custom compactor can introduce an uncalibrated image. Keep the
			// conservative original estimate until its native recount validates it.
			if (cost === undefined)
				return Math.max(
					1,
					Math.ceil(options.baseEstimateMessageTokens(message) * textScale),
				);
			visionTokens += cost * count;
		}
		const text = images.size > 0 ? withoutImages(message) : message;
		const estimate = Math.max(
			1,
			Math.ceil(
				options.baseEstimateMessageTokens(text) * textScale + visionTokens,
			),
		);
		cache.set(message, estimate);
		return estimate;
	};
}
