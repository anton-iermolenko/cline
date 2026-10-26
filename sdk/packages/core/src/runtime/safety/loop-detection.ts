/**
 * Repeated tool-call loop detection.
 *
 * @see PLAN.md §3.1 — helpers moved from `packages/agents/src/context/loop-detection.ts`.
 * @see PLAN.md §3.2.3 — public surface of `LoopDetectionTracker`.
 *
 * The pure helpers (`createLoopDetectionState`, `resetLoopDetectionState`,
 * `toolCallSignature`, `checkRepeatedToolCall`) are ported verbatim. The
 * `LoopDetectionTracker` class is a thin wrapper that owns a
 * `LoopDetectionState` and exposes the `inspect()` / `reset()` surface that
 * `SessionRuntime` installs as a `beforeTool` hook per §3.2.3.
 */

import { createHash } from "node:crypto";
import type { LoopDetectionConfig } from "@cline/shared";

// =============================================================================
// Pure helpers (verbatim port)
// =============================================================================

export interface LoopDetectionState {
	lastToolName: string;
	lastToolSignature: string;
	consecutiveIdenticalCount: number;
}

export function createLoopDetectionState(): LoopDetectionState {
	return {
		lastToolName: "",
		lastToolSignature: "",
		consecutiveIdenticalCount: 0,
	};
}

export function resetLoopDetectionState(state: LoopDetectionState): void {
	state.lastToolName = "";
	state.lastToolSignature = "";
	state.consecutiveIdenticalCount = 0;
}

function sortKeys(value: unknown): unknown {
	if (value == null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sortKeys);
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
	}
	return sorted;
}

export function toolCallSignature(input: unknown): string {
	if (input == null) return "null";
	if (typeof input === "string") return input;
	if (typeof input !== "object") return String(input);
	try {
		return JSON.stringify(sortKeys(input));
	} catch {
		return String(input);
	}
}

export interface LoopCheckResult {
	softWarning: boolean;
	hardEscalation: boolean;
}

export function checkRepeatedToolCall(
	state: LoopDetectionState,
	toolName: string,
	signature: string,
	config: LoopDetectionConfig,
): LoopCheckResult {
	if (
		toolName === state.lastToolName &&
		signature === state.lastToolSignature
	) {
		state.consecutiveIdenticalCount++;
	} else {
		state.consecutiveIdenticalCount = 1;
	}
	state.lastToolName = toolName;
	state.lastToolSignature = signature;

	return {
		softWarning: state.consecutiveIdenticalCount === config.softThreshold,
		hardEscalation: state.consecutiveIdenticalCount >= config.hardThreshold,
	};
}

// =============================================================================
// Class wrapper (new — per PLAN.md §3.2.3)
// =============================================================================

/**
 * Verdict returned by {@link LoopDetectionTracker.inspect}.
 *
 * - `"ok"`   — no repeated call detected.
 * - `"soft"` — soft-warning threshold reached; SessionRuntime may surface a
 *              recovery notice but should not block the call.
 * - `"hard"` — hard-escalation threshold reached; SessionRuntime should
 *              stop the run with the provided `message`.
 */
export interface LoopDetectionVerdict {
	kind: "ok" | "soft" | "hard";
	message?: string;
}

/** Minimal call shape the tracker needs; matches `AgentToolCallPart` subset. */
export interface LoopDetectionCall {
	name: string;
	input: unknown;
}

const DEFAULT_CONFIG: LoopDetectionConfig = {
	softThreshold: 3,
	hardThreshold: 5,
};

/**
 * Per-session repeated-tool-call detector.
 *
 * `SessionRuntime` owns the instance and installs a `beforeTool` hook
 * (see `AgentRuntimeHooks.beforeTool`) that calls `inspect()` to decide
 * whether to return `{ skip, stop, reason }`.
 */
export class LoopDetectionTracker {
	private readonly config: LoopDetectionConfig;
	private readonly state: LoopDetectionState = createLoopDetectionState();
	private observations: { target: string; hash: string }[] = [];

	constructor(config?: Partial<LoopDetectionConfig>) {
		this.config = {
			softThreshold: config?.softThreshold ?? DEFAULT_CONFIG.softThreshold,
			hardThreshold: config?.hardThreshold ?? DEFAULT_CONFIG.hardThreshold,
		};
	}

	inspect(call: LoopDetectionCall): LoopDetectionVerdict {
		const signature = toolCallSignature(call.input);
		const result = checkRepeatedToolCall(
			this.state,
			call.name,
			signature,
			this.config,
		);
		if (result.hardEscalation) {
			return {
				kind: "hard",
				message: `Detected ${this.state.consecutiveIdenticalCount} consecutive identical calls to \`${call.name}\`; stopping to avoid a loop.`,
			};
		}
		if (result.softWarning) {
			return {
				kind: "soft",
				message: `Detected ${this.state.consecutiveIdenticalCount} consecutive identical calls to \`${call.name}\`; consider trying a different approach.`,
			};
		}
		return { kind: "ok" };
	}

	/** Detect unchanged observations even when other read calls alternate between them. */
	observeResult(
		call: LoopDetectionCall,
		output: unknown,
		isError = false,
	): LoopDetectionVerdict {
		const target = observationTarget(call);
		if (!target || isError) {
			this.observations = [];
			return { kind: "ok" };
		}
		const hash = createHash("sha256")
			.update(observationText(output))
			.digest("hex");
		const prior = this.observations.filter((v) => v.target === target).at(-1);
		if (prior && prior.hash !== hash)
			this.observations = this.observations.filter((v) => v.target !== target);
		this.observations.push({ target, hash });
		this.observations = this.observations.slice(-16);
		const count = this.observations.filter(
			(v) => v.target === target && v.hash === hash,
		).length;
		if (count < this.config.softThreshold) return { kind: "ok" };
		const message =
			"The same read-only observation has returned unchanged " +
			count +
			" times without an intervening edit. Use the evidence already available and complete the remaining work. Reopen only a named missing detail or changed source.";
		return count >= this.config.hardThreshold
			? { kind: "hard", message }
			: count === this.config.softThreshold
				? { kind: "soft", message }
				: { kind: "ok" };
	}

	reset(): void {
		resetLoopDetectionState(this.state);
		this.observations = [];
	}
}

function observationTarget(call: LoopDetectionCall): string | undefined {
	if (!call.input || typeof call.input !== "object") return;
	const input = call.input as Record<string, unknown>;
	if (call.name === "read_files") {
		const files = Array.isArray(input.files) ? input.files : [input];
		const paths = files.map((v) =>
			v && typeof v === "object"
				? (v as Record<string, unknown>).path
				: undefined,
		);
		if (paths.length && paths.every((v) => typeof v === "string"))
			return `files:${JSON.stringify(paths)}`;
	}
	if (call.name === "run_commands") {
		const commands = Array.isArray(input.commands) ? input.commands : [];
		if (!commands.length || !commands.every((v) => typeof v === "string"))
			return;
		// Only recognize a deliberately narrow set of inspections. Unknown commands
		// may mutate files; they reset observations rather than inventing no progress.
		const safe = commands.every((command) =>
			command
				.split(/&&|;|\n/)
				.filter((v) => v.trim())
				.every(
					(part) =>
						!/[<>|$\x60]/.test(part) &&
						!/--(?:output|ext-diff|textconv|pre|exec)\b/.test(part) &&
						/^\s*(?:cd\s+[^;&]+|git\s+(?:diff|status|show|log)\b[^;&]*|(?:cat|head|tail|wc|rg|grep|ls)\s+[^;&]*)$/.test(
							part,
						),
				),
		);
		if (safe) return `commands:${toolCallSignature(commands)}`;
	}
	return undefined;
}
function observationText(value: unknown): string {
	if (typeof value === "string") {
		try {
			return observationText(JSON.parse(value));
		} catch {
			return value;
		}
	}
	if (Array.isArray(value)) return value.map(observationText).join("\n");
	if (value && typeof value === "object") {
		const v = value as Record<string, unknown>;
		for (const key of ["result", "text", "content"])
			if (v[key] !== undefined) return observationText(v[key]);
	}
	return JSON.stringify(value) ?? "";
}
