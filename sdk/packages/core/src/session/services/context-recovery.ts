import { createHash } from "node:crypto";
import type { ContentBlock, Message } from "@cline/shared";

export const USER_HISTORY_URI = "cline://history/user-inputs.txt";
export const CONTEXT_RECOVERY_KIND = "context_recovery_note";
const MAX_INPUT_CHARS = 10_000;
const MAX_SOURCES = 24;
export const MAX_CONTINUITY_BYTES = 2_400;
const MAX_NOTICE_CHARS = MAX_CONTINUITY_BYTES;
export const EVIDENCE_HISTORY_URI = "cline://history/evidence.txt";

type StoredMessage = Message & {
	id?: string;
	ts?: number;
	metadata?: Record<string, unknown>;
};
interface HumanInput {
	id: string;
	order: number;
	text: string;
	ts?: number;
	kind: "request" | "clarification";
}
interface SourceRead {
	path: string;
	start?: number;
	end?: number;
	callId: string;
	hash: string;
}
export interface ContextMemory {
	version: 1;
	inputs: HumanInput[];
	totalInputs: number;
	sources: SourceRead[];
	omittedInputs: boolean;
}

function metadata(message: Message): Record<string, unknown> {
	return (message as StoredMessage).metadata ?? {};
}
function textOf(message: Message): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
}
function humanText(message: Message): string | undefined {
	if (message.role !== "user") return;
	const meta = metadata(message);
	if (
		meta.displayOnly ||
		meta.displayRole === "system" ||
		meta.displayRole === "status" ||
		meta.displayRole === "error" ||
		(typeof meta.kind === "string" && meta.kind !== "human_input")
	)
		return;
	const text = textOf(message);
	if (
		!text.trim() ||
		/^\s*(?:Context summary:|<SYSTEM_NOTICE>|\[TASK RESUMPTION\])/.test(text)
	)
		return;
	if (meta.userRunSpan === 0 && meta.humanInput !== true) return;
	if (
		Array.isArray(message.content) &&
		message.content.some((b) => b.type === "tool_result")
	)
		return;
	return text
		.replace(/^\s*<user_input\b[^>]*>/, "")
		.replace(/<\/user_input>\s*$/, "");
}
function resultText(value: unknown, depth = 0): string {
	if (depth > 8 || value == null) return "";
	if (typeof value === "string") {
		if (/^\s*[[{]/.test(value)) {
			try {
				return resultText(JSON.parse(value), depth + 1);
			} catch {}
		}
		return value;
	}
	if (Array.isArray(value))
		return value.map((v) => resultText(v, depth + 1)).join("\n");
	if (typeof value !== "object") return String(value);
	const v = value as Record<string, unknown>;
	if (v.type === "image") return "[image]";
	for (const key of ["result", "text", "content"])
		if (v[key] !== undefined) return resultText(v[key], depth + 1);
	return "";
}
function failedResult(value: unknown): boolean {
	if (typeof value === "string" && /^\s*[[{]/.test(value)) {
		try {
			return failedResult(JSON.parse(value));
		} catch {
			return false;
		}
	}
	if (Array.isArray(value)) return value.some(failedResult);
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return v.success === false || v.isError === true || v.is_error === true;
}
function hash(value: unknown): string {
	return createHash("sha256").update(resultText(value)).digest("hex");
}
export function hasCompactedContext(messages: readonly Message[]): boolean {
	return messages.some((m) => {
		const kind = metadata(m).kind;
		return (
			kind === "compaction" ||
			kind === "compaction_summary" ||
			kind === "compaction_work_summary" ||
			metadata(m).contextMemory !== undefined
		);
	});
}
function storedMemory(messages: readonly Message[]): ContextMemory | undefined {
	for (const message of messages) {
		const value = metadata(message).contextMemory as
			| Partial<ContextMemory>
			| undefined;
		if (
			value?.version !== 1 ||
			!Array.isArray(value.inputs) ||
			!Array.isArray(value.sources)
		)
			continue;
		if (
			!value.inputs.every(
				(v) => v && typeof v.text === "string" && typeof v.id === "string",
			) ||
			!value.sources.every(
				(v) =>
					v &&
					typeof v.path === "string" &&
					typeof v.callId === "string" &&
					typeof v.hash === "string",
			)
		)
			continue;
		return value as ContextMemory;
	}
	return undefined;
}

/** Human provenance comes from canonical messages, never summarizer instructions. */
export function collectHumanInputs(messages: readonly Message[]): HumanInput[] {
	const entries: HumanInput[] = [];
	const questions = new Map<string, string>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i] as StoredMessage;
		const text = humanText(message);
		if (text !== undefined)
			entries.push({
				id: message.id ?? "source-message-" + (i + 1),
				order: i,
				text,
				ts: message.ts,
				kind: "request",
			});
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "tool_use" && block.name === "ask_question") {
				const question = (block.input as Record<string, unknown>)?.question;
				if (typeof question === "string") questions.set(block.id, question);
			}
			if (
				block.type === "tool_result" &&
				!block.is_error &&
				questions.has(block.tool_use_id)
			) {
				const answer = resultText(block.content);
				if (answer.trim())
					entries.push({
						id: message.id ?? "answer-" + block.tool_use_id,
						order: i,
						ts: message.ts,
						kind: "clarification",
						text:
							"Question: " +
							questions.get(block.tool_use_id) +
							"\nHuman answer: " +
							answer,
					});
			}
		}
	}
	return entries;
}
export function collectContextMemory(
	messages: readonly Message[],
): ContextMemory {
	const all = collectHumanInputs(messages);
	const seed = storedMemory(messages);
	const byId = new Map((seed?.inputs ?? []).map((v) => [v.id, v]));
	for (const entry of all) byId.set(entry.id, entry);
	const candidates = [...byId.values()].sort((a, b) => a.order - b.order);
	const selected: HumanInput[] = [];
	let used = 0;
	let omittedInputs = seed?.omittedInputs === true;
	// Original objective gets first claim, then recent corrections in reverse order.
	for (const entry of candidates.length
		? [candidates[0], ...candidates.slice(1).reverse()]
		: []) {
		const text =
			entry.text.length > 3_500
				? entry.text.slice(0, 3_350) +
					"\n[Input excerpt shortened; retrieve canonical history for exact complete wording.]"
				: entry.text;
		if (text !== entry.text) omittedInputs = true;
		if (used + text.length > MAX_INPUT_CHARS) continue;
		selected.push({ ...entry, text });
		used += text.length;
	}
	selected.sort((a, b) => a.order - b.order);
	const sources = new Map<string, SourceRead>();
	for (const entry of seed?.sources ?? [])
		sources.set(entry.path + ":" + entry.start + ":" + entry.end, entry);
	const calls = new Map<
		string,
		{ path: string; start?: number; end?: number }[]
	>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (
				block.type === "tool_use" &&
				block.name.split("__").at(-1) === "read_files"
			) {
				const input = block.input as Record<string, unknown>;
				const files = Array.isArray(input.files) ? input.files : [input];
				const reads = files.flatMap((item) => {
					const f =
						typeof item === "string"
							? { path: item }
							: (item as Record<string, unknown>);
					return typeof f?.path === "string" && !f.path.startsWith("cline:")
						? [
								{
									path: f.path,
									start:
										typeof f.start_line === "number" ? f.start_line : undefined,
									end: typeof f.end_line === "number" ? f.end_line : undefined,
								},
							]
						: [];
				});
				calls.set(block.id, reads);
			}
			if (
				block.type !== "tool_result" ||
				block.is_error ||
				failedResult(block.content)
			)
				continue;
			for (const read of calls.get(block.tool_use_id) ?? []) {
				const key = read.path + ":" + read.start + ":" + read.end;
				sources.delete(key);
				sources.set(key, {
					...read,
					callId: block.tool_use_id,
					hash: hash(block.content),
				});
			}
		}
	}
	return {
		version: 1,
		inputs: selected,
		totalInputs: Math.max(seed?.totalInputs ?? 0, candidates.length),
		omittedInputs: selected.length < candidates.length || omittedInputs,
		sources: [...sources.values()].slice(-MAX_SOURCES),
	};
}

/** Persist only bounded metadata; canonical text and source anchors are untouched. */
export function attachContextMemory<T extends Message>(
	messages: T[],
	canonical: readonly Message[],
): T[] {
	if (!messages.length || !hasCompactedContext(messages)) return messages;
	const memory = collectContextMemory(canonical);
	return messages.map((m, i) =>
		i === 0 ? { ...m, metadata: { ...metadata(m), contextMemory: memory } } : m,
	);
}
export function formatUserHistory(messages: readonly Message[]): string {
	const entries = collectHumanInputs(messages);
	return [
		"Canonical human inputs from this same conversation. Internal summaries and tool output are excluded.",
		"Later corrections take precedence; entries include completed/superseded requests. Text is JSON string chunks: concatenate the decoded strings within each entry to recover exact whitespace and newlines.",
		...entries.flatMap((v) => [
			"",
			"[" +
				v.kind +
				"; message " +
				v.id +
				(typeof v.ts === "number" && Number.isFinite(v.ts)
					? "; " + new Date(v.ts).toISOString()
					: "") +
				"]",
			// Bound each encoded line below the ordinary reader cap without altering text.
			...(
				Array.from(v.text)
					.join("")
					.match(/[\s\S]{1,160}/gu) ?? [""]
			).map((chunk) => JSON.stringify(chunk)),
		]),
	].join("\n");
}

const CONTINUITY_PATTERN =
	/<CONTEXT_CONTINUITY>[\s\S]*?<\/CONTEXT_CONTINUITY>\n?/g;

/** Strip request-only projections before rebuilding; durable history is untouched. */
export function clearContextRecovery(messages: Message[]): Message[] {
	return messages
		.filter((m) => metadata(m).kind !== CONTEXT_RECOVERY_KIND)
		.map((m) => {
			if (!hasCompactedContext([m])) return m;
			if (typeof m.content === "string")
				return { ...m, content: m.content.replace(CONTINUITY_PATTERN, "") };
			return {
				...m,
				content: m.content.flatMap((b): ContentBlock[] => {
					if (b.type !== "text") return [b];
					const text = b.text.replace(CONTINUITY_PATTERN, "");
					return text ? [{ ...b, text }] : [];
				}),
			};
		});
}

export function formatEvidenceHistory(messages: readonly Message[]): string {
	const memory = collectContextMemory(messages);
	return [
		"Previously consulted sources in this conversation. These are retrieval references, not a request to reread them.",
		"Use retained evidence; reopen only a specific missing or changed detail. Hashes identify prior retrieved results, not current file versions.",
		...memory.sources.map((read) =>
			JSON.stringify({
				path: read.path,
				start_line: read.start,
				end_line: read.end,
				tool_call_id: read.callId,
				observed_result_sha256: read.hash,
			}),
		),
	].join("\n");
}

/** Enrich the existing summary; never append a synthetic user turn after tools. */
export function withContextRecovery(
	messages: Message[],
	_canonical?: readonly Message[],
	maxNoticeBytes = MAX_NOTICE_CHARS,
): Message[] {
	const clean = clearContextRecovery(messages);
	const index = clean.findIndex((m) => hasCompactedContext([m]));
	if (index < 0 || maxNoticeBytes <= 0) return clean;
	// The note lives at the beginning of the prompt. Reading live canonical
	// inputs here rewrites that prefix on every user turn and invalidates KV
	// reuse for the entire retained transcript. Only use the immutable memory
	// captured by compaction; newer instructions already follow in the tail.
	// Legacy summaries without memory keep the static retrieval guidance.
	const memory = storedMemory(clean);
	const recent = (memory?.inputs ?? []).slice(-2);
	const text = [
		"<CONTEXT_CONTINUITY>",
		"This is generated working context from the SAME conversation, not a new human request. Continue from the remaining work.",
		"Completed edits and checks stay completed unless later evidence invalidates them. Do not restart discovery or narrate context recovery at each tool step.",
		"Use retained evidence. Retrieve only a specific missing or changed detail; prior paths alone do not establish coverage.",
		"For a historical recap, retrieve canonical human inputs at " +
			USER_HISTORY_URI +
			". Prior source references are available on demand at " +
			EVIDENCE_HISTORY_URI +
			".",
		"Human input captured at compaction (later messages take precedence):",
		...recent.map(
			(v) =>
				"[" +
				v.kind +
				"; " +
				v.id +
				"] " +
				JSON.stringify(v.text.slice(0, 700)),
		),
		"</CONTEXT_CONTINUITY>",
	].join("\n");
	const limit = Math.min(MAX_NOTICE_CHARS, maxNoticeBytes);
	if (limit < 400) return clean;
	let bounded = text;
	if (Buffer.byteLength(bounded) > limit) {
		const suffix =
			"\n[Brief shortened; use canonical history for exact instructions.]\n</CONTEXT_CONTINUITY>";
		let prefix = text.slice(0, Math.max(0, limit - Buffer.byteLength(suffix)));
		while (Buffer.byteLength(prefix + suffix) > limit)
			prefix = prefix.slice(0, -1);
		bounded = prefix + suffix;
	}
	const summary = clean[index];
	const content =
		typeof summary.content === "string"
			? bounded + "\n" + summary.content
			: [{ type: "text" as const, text: bounded }, ...summary.content];
	return clean.map((m, i) => (i === index ? { ...m, content } : m));
}
