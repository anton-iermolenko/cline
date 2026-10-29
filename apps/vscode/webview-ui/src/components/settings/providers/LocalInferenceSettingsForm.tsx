import {
	DEFAULT_COMPACTION_BUFFER_TOKENS,
	type LocalInferenceOverrideField,
	type LocalInferenceSettings,
	type LocalModelBudget,
	localInferenceUserOverrides,
	resolveLocalInferenceSettings,
	resolveLocalModelBudget,
} from "@cline/shared"
import type { ProviderConfigResponse } from "@shared/proto/cline/models"
import { type CSSProperties, useEffect, useState } from "react"

const samplingFields = [
	["temperature", "Temperature"],
	["topP", "Top P"],
	["topK", "Top K"],
	["minP", "Min P"],
	["repeatPenalty", "Repeat penalty"],
	["presencePenalty", "Presence penalty"],
	["frequencyPenalty", "Frequency penalty"],
] as const
const grid: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, max(145px, calc(50% - 8px))), 1fr))",
	gap: "12px 16px",
}
const inputStyle: CSSProperties = {
	width: "100%",
	minWidth: 0,
	boxSizing: "border-box",
	color: "var(--vscode-input-foreground)",
	background: "var(--vscode-input-background)",
	border: "1px solid var(--vscode-input-border)",
	padding: 6,
}
const hint: CSSProperties = { color: "var(--vscode-descriptionForeground)", fontSize: 12, margin: "6px 0 12px" }
const format = (value: number) => Math.floor(value).toLocaleString()

function ContextBreakdown({ budget }: { budget: LocalModelBudget }) {
	const parts = [
		{ label: "Tools & instructions (estimate)", tokens: budget.overheadTokens, color: "#64748b" },
		{ label: "Summarized history (output allowance)", tokens: budget.summaryTokens, color: "#a78bfa" },
		{ label: "Raw recent history (estimate)", tokens: budget.recentTokens, color: "#2dd4bf" },
		{ label: "Next normal output (including thinking)", tokens: budget.maxOutputTokens, color: "#fb923c" },
		{ label: "Counting margin + boundary", tokens: budget.marginTokens + budget.boundaryTokens, color: "#f472b6" },
		{ label: "Minimum iteration reserve", tokens: budget.iterationReserveTokens, color: "#2563eb" },
		{ label: "Additional iteration space", tokens: budget.growthTokens - budget.iterationReserveTokens, color: "#60a5fa" },
	]
	return (
		<section aria-label="Context budget breakdown" style={{ marginTop: 16 }}>
			<h4 style={{ marginBottom: 8 }}>Context budget breakdown</h4>
			<div
				aria-label="Estimated allocation of maximum context"
				role="img"
				style={{ display: "flex", height: 12, overflow: "hidden", borderRadius: 3, marginBottom: 10 }}>
				{parts.map((part) => (
					<div
						key={part.label}
						style={{ width: `${(part.tokens / budget.contextWindow) * 100}%`, background: part.color }}
						title={`${part.label}: ${format(part.tokens)} tokens`}
					/>
				))}
			</div>
			<dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "5px 12px", margin: 0 }}>
				{parts.map((part) => (
					<div key={part.label} style={{ display: "contents" }}>
						<dt>{part.label}</dt>
						<dd style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{format(part.tokens)}</dd>
					</div>
				))}
				<div style={{ display: "contents", fontWeight: 600 }}>
					<dt>Compaction target subtotal</dt>
					<dd style={{ margin: 0 }}>{format(budget.targetTokens)}</dd>
				</div>
				<div style={{ display: "contents", fontWeight: 600 }}>
					<dt>Total iteration space</dt>
					<dd style={{ margin: 0 }}>{format(budget.growthTokens)}</dd>
				</div>
				<div style={{ display: "contents", fontWeight: 600 }}>
					<dt>Compaction trigger (input)</dt>
					<dd style={{ margin: 0 }}>{format(budget.inputCapTokens)}</dd>
				</div>
				<div style={{ display: "contents", fontWeight: 600 }}>
					<dt>Hard compaction cap</dt>
					<dd style={{ margin: 0 }}>{format(budget.hardCapTokens)}</dd>
				</div>
				<div style={{ display: "contents", fontWeight: 600 }}>
					<dt>Maximum context size</dt>
					<dd style={{ margin: 0 }}>{format(budget.contextWindow)}</dd>
				</div>
			</dl>
			{budget.targetTokens < budget.overheadTokens + budget.summaryTokens && (
				<p role="status">
					This target leaves no raw recent history under the 10K overhead estimate. Increase the target or reduce the
					summary budget.
				</p>
			)}
		</section>
	)
}

export function LocalInferenceSettingsForm({
	config,
	selectedModelId,
	write,
}: {
	config: ProviderConfigResponse | undefined
	selectedModelId: string
	write: (patch: { localInferenceJson: string; localInferenceModelId: string; localInferenceScope: string }) => Promise<unknown>
}) {
	const [settings, setSettings] = useState<LocalInferenceSettings>({})
	const [error, setError] = useState<string>()
	const [saving, setSaving] = useState(false)
	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset drafts/errors on server/model changes even if JSON is identical.
	useEffect(() => {
		setSettings(config?.localInferenceJson ? JSON.parse(config.localInferenceJson) : {})
		setError(undefined)
	}, [config?.localInferenceJson, config?.localInferenceModelId, config?.localInferenceScope])
	const disabled = saving || !config?.localInferenceModelId || config.localInferenceModelId !== selectedModelId
	const effective = resolveLocalInferenceSettings(settings)
	const editedFields = localInferenceUserOverrides(settings)
	const active = (key: LocalInferenceOverrideField) =>
		!(settings.disabledOverrides ?? []).includes(key) &&
		(editedFields.includes(key) ||
			(key.startsWith("compaction.") &&
				settings.compaction?.[key.slice(11) as keyof NonNullable<LocalInferenceSettings["compaction"]>] !== undefined))
	let budget: LocalModelBudget | undefined
	let budgetError: string | undefined
	try {
		budget = resolveLocalModelBudget(settings)
		if (
			effective.thinking !== false &&
			effective.thinkingBudgetTokens &&
			effective.thinkingBudgetTokens >= budget.maxOutputTokens
		)
			throw new Error("Thinking must leave room for the answer within normal output tokens.")
	} catch (e) {
		budgetError = e instanceof Error ? e.message : String(e)
	}
	const save = async (next: LocalInferenceSettings) => {
		if (disabled || !config?.localInferenceModelId) return
		setError(undefined)
		try {
			resolveLocalModelBudget(next)
			setSaving(true)
			await write({
				localInferenceJson: JSON.stringify(next),
				localInferenceModelId: config.localInferenceModelId,
				localInferenceScope: config.localInferenceScope ?? "",
			})
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setSaving(false)
		}
	}
	const mark = (next: LocalInferenceSettings, key: LocalInferenceOverrideField, enabled = true): LocalInferenceSettings => {
		const fields = new Set(editedFields)
		const inactive = new Set(settings.disabledOverrides ?? [])
		if (enabled) {
			fields.add(key)
			inactive.delete(key)
		} else fields.delete(key)
		return { ...next, userOverrides: [...fields], disabledOverrides: [...inactive] }
	}
	const numeric = (key: LocalInferenceOverrideField, label: string, value: number | undefined, locked = false) => {
		const custom = !locked && active(key)
		return (
			<label key={key} style={{ display: "grid", gap: 4, alignContent: "start", minWidth: 0 }}>
				<input
					aria-label={label}
					disabled={disabled || locked}
					onBlur={() => void save(settings)}
					onChange={(event) => {
						const value = event.target.value === "" ? undefined : Number(event.target.value)
						const next = key.startsWith("compaction.")
							? { ...settings, compaction: { ...settings.compaction, [key.slice(11)]: value } }
							: { ...settings, [key]: value }
						setSettings(mark(next, key, value !== undefined))
					}}
					placeholder="Required / server default unknown"
					step={samplingFields.some(([field]) => field === key) ? "any" : "1"}
					style={{
						...inputStyle,
						color: custom ? "var(--vscode-input-foreground)" : "var(--vscode-descriptionForeground)",
						fontStyle: custom ? "normal" : "italic",
					}}
					type="number"
					value={value ?? ""}
				/>
				<span>{label}</span>
			</label>
		)
	}
	const overrideField = (
		key:
			| "contextWindow"
			| "maxOutputTokens"
			| "compaction.targetTokens"
			| "compaction.summaryTokens"
			| "compaction.bufferTokens",
		label: string,
		value: number | undefined,
		toggleLabel: string,
	) => {
		const required = key === "contextWindow" && !settings.serverDefaults?.contextWindow
		const checked = active(key) || required
		return (
			<div key={key}>
				<label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
					<input
						aria-label={toggleLabel}
						checked={checked}
						disabled={disabled || required}
						onChange={(event) => {
							const enabled = event.target.checked
							let next = { ...settings }
							if (enabled) {
								if (key !== "contextWindow" && key !== "maxOutputTokens") {
									const field = key.slice(11) as keyof NonNullable<LocalInferenceSettings["compaction"]>
									next.compaction = { ...settings.compaction, [field]: settings.compaction?.[field] ?? value }
								} else next[key] = settings[key] ?? value
								next = mark(next, key)
							} else next.disabledOverrides = [...new Set([...(settings.disabledOverrides ?? []), key])]
							setSettings(next)
							void save(next)
						}}
						type="checkbox"
					/>
					<span>{required ? "Manual value required" : "Override"}</span>
				</label>
				{numeric(key, label, value, !checked)}
			</div>
		)
	}
	const select = (key: "supportsVision" | "supportsTools" | "supportsReasoning" | "thinking", label: string) => (
		<label key={key} style={{ display: "grid", gap: 4 }}>
			<select
				aria-label={label}
				disabled={disabled}
				onChange={(event) => {
					const next = mark(
						{ ...settings, [key]: event.target.value === "" ? undefined : event.target.value === "true" },
						key,
						event.target.value !== "",
					)
					setSettings(next)
					void save(next)
				}}
				style={{
					...inputStyle,
					fontStyle: active(key) ? "normal" : "italic",
					color: active(key) ? "var(--vscode-input-foreground)" : "var(--vscode-descriptionForeground)",
				}}
				value={effective[key] === undefined ? "" : String(effective[key])}>
				<option value="">Server default / unknown</option>
				<option value="true">{key === "thinking" ? "On" : "Supported"}</option>
				<option value="false">{key === "thinking" ? "Off" : "Unsupported"}</option>
			</select>
			<span>{label}</span>
		</label>
	)
	return (
		<fieldset disabled={disabled} style={{ border: "none", padding: 0, marginTop: 16, minWidth: 0 }}>
			<legend style={{ fontWeight: 600 }}>Model context & compaction</legend>
			<p style={hint}>
				Grey italic: server/calculated defaults. Normal: your overrides. Switching an override off preserves its saved
				number for later.
			</p>
			<div style={grid}>
				{overrideField(
					"contextWindow",
					"Maximum context size (tokens)",
					effective.contextWindow,
					"Override maximum context size",
				)}
				{overrideField(
					"maxOutputTokens",
					"Normal output tokens (including thinking)",
					effective.maxOutputTokens,
					"Override normal output",
				)}
				{overrideField(
					"compaction.targetTokens",
					"Compaction target tokens",
					effective.compaction?.targetTokens ?? budget?.targetTokens,
					"Override compaction target",
				)}
				{overrideField(
					"compaction.summaryTokens",
					"Summarized history tokens",
					effective.compaction?.summaryTokens ?? budget?.summaryTokens,
					"Override summarized history",
				)}
			</div>
			{budget && <ContextBreakdown budget={budget} />}
			<details style={{ marginTop: 16 }}>
				<summary style={{ cursor: "pointer", fontWeight: 600 }}>Advanced settings</summary>
				<h4>Thinking for normal conversation</h4>
				<div style={grid}>
					{select("thinking", "Thinking")}
					{numeric("thinkingBudgetTokens", "Thinking token budget", effective.thinkingBudgetTokens)}
					<label style={{ display: "grid", gap: 4 }}>
						<input
							aria-label="Reasoning effort"
							disabled={disabled}
							onBlur={() => void save(settings)}
							onChange={(event) =>
								setSettings(
									mark(
										{ ...settings, reasoningEffort: event.target.value || undefined },
										"reasoningEffort",
										!!event.target.value,
									),
								)
							}
							placeholder="Server default / unknown"
							style={{
								...inputStyle,
								fontStyle: active("reasoningEffort") ? "normal" : "italic",
								color: active("reasoningEffort")
									? "var(--vscode-input-foreground)"
									: "var(--vscode-descriptionForeground)",
							}}
							value={effective.reasoningEffort ?? ""}
						/>
						<span>Reasoning effort</span>
					</label>
				</div>
				<p style={hint}>Thinking consumes part of normal output. Compaction summaries request thinking off.</p>
				<h4>Counting margin</h4>
				{overrideField(
					"compaction.bufferTokens",
					"Counting margin (tokens)",
					effective.compaction?.bufferTokens ?? DEFAULT_COMPACTION_BUFFER_TOKENS,
					"Override counting margin",
				)}
				<h4>Sampling & penalties</h4>
				<div style={grid}>{samplingFields.map(([key, label]) => numeric(key, label, effective[key]))}</div>
				<h4>Model capabilities</h4>
				<div style={grid}>
					{select("supportsVision", "Image inputs")}
					{select("supportsTools", "Tool calling")}
					{select("supportsReasoning", "Reasoning support")}
				</div>
			</details>
			<p style={hint}>
				Input counting:{" "}
				{effective.inputTokenCounting === false
					? "estimated; 2,048 tokens per image. Estimation can trigger compaction earlier."
					: "native preflight; counting errors stop the request."}
			</p>
			{(error ?? budgetError) && (
				<p role="alert" style={{ color: "var(--vscode-errorForeground)" }}>
					{error ?? budgetError}
				</p>
			)}
		</fieldset>
	)
}
