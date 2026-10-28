import {
	COMPACTION_TRIGGER_RATIO,
	DEFAULT_COMPACTION_BUFFER_TOKENS,
	type LocalInferenceOverrideField,
	type LocalInferenceSettings,
	localInferenceUserOverrides,
	resolveAutoCompactionTargetTokens,
	resolveLocalInferenceInputTokens,
} from "@cline/shared"
import type { ProviderConfigResponse } from "@shared/proto/cline/models"
import { type CSSProperties, useEffect, useId, useState } from "react"

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
type NumericKey =
	| "contextWindow"
	| "maxInputTokens"
	| "maxOutputTokens"
	| "thinkingBudgetTokens"
	| (typeof samplingFields)[number][0]
type CompactionKey = keyof NonNullable<LocalInferenceSettings["compaction"]>

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
	const [inputOverride, setInputOverride] = useState(false)
	const [compactionOverride, setCompactionOverride] = useState(false)
	const budgetHelpId = useId()
	const safetyMarginHelpId = useId()
	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset drafts and errors when server/model changes even if the JSON is identical.
	useEffect(() => {
		const next: LocalInferenceSettings = config?.localInferenceJson ? JSON.parse(config.localInferenceJson) : {}
		setSettings(next)
		setInputOverride(next.maxInputTokens !== undefined)
		setCompactionOverride(Object.values(next.compaction ?? {}).some((value) => value !== undefined))
		setError(undefined)
	}, [config?.localInferenceJson, config?.localInferenceModelId, config?.localInferenceScope])
	const disabled = saving || !config?.localInferenceModelId || config.localInferenceModelId !== selectedModelId
	const save = async (next: LocalInferenceSettings) => {
		if (disabled || !config?.localInferenceModelId) return
		setSaving(true)
		setError(undefined)
		try {
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
	const counting = settings.inputTokenCounting !== false
	let automaticInput: number | undefined
	let budgetError: string | undefined
	try {
		automaticInput = resolveLocalInferenceInputTokens({ ...settings, maxInputTokens: undefined, nativeCounting: counting })
	} catch (e) {
		budgetError = e instanceof Error ? e.message : String(e)
	}
	if (
		settings.thinking !== false &&
		settings.thinkingBudgetTokens &&
		settings.maxOutputTokens &&
		settings.thinkingBudgetTokens >= settings.maxOutputTokens
	) {
		budgetError = "Thinking must leave room for the answer within maximum output tokens."
	}
	const input = automaticInput === undefined ? undefined : Math.min(settings.maxInputTokens ?? Infinity, automaticInput)
	const buffer = settings.compaction?.bufferTokens ?? DEFAULT_COMPACTION_BUFFER_TOKENS
	const trigger = input === undefined ? undefined : counting ? Math.max(1, input - buffer) : input * COMPACTION_TRIGGER_RATIO
	const targetFor = (messagePairCount: number) =>
		input === undefined || trigger === undefined
			? undefined
			: Math.max(
					1,
					Math.min(
						settings.compaction?.targetTokens ??
							resolveAutoCompactionTargetTokens({
								maxInputTokens: input,
								modelMaxTokens: settings.maxOutputTokens,
								triggerTokens: trigger,
								messagePairCount,
							}),
						Math.max(1, trigger - 1),
						settings.compaction?.maxTargetTokens ?? Infinity,
					),
				)
	const target = targetFor(0)
	const longTarget = targetFor(5)
	const format = (value: number | undefined) => (value === undefined ? "unknown" : Math.floor(value).toLocaleString())
	const markOverride = (
		next: LocalInferenceSettings,
		key: LocalInferenceOverrideField,
		enabled: boolean,
	): LocalInferenceSettings => {
		const fields = new Set(localInferenceUserOverrides(settings))
		if (enabled) fields.add(key)
		else fields.delete(key)
		return { ...next, userOverrides: [...fields] }
	}
	const valueStyle = (key: LocalInferenceOverrideField, locked = false): CSSProperties => ({
		...inputStyle,
		color:
			!locked && localInferenceUserOverrides(settings).includes(key)
				? "var(--vscode-input-foreground)"
				: "var(--vscode-descriptionForeground)",
		fontStyle: !locked && localInferenceUserOverrides(settings).includes(key) ? "normal" : "italic",
	})
	const numeric = (
		key: NumericKey | CompactionKey,
		label: string,
		value: number | undefined,
		options: { locked?: boolean; compaction?: boolean; help?: string; describedBy?: string } = {},
	) => (
		<label key={key} style={{ display: "grid", alignContent: "start", gap: 4, minWidth: 0 }}>
			<input
				aria-describedby={options.describedBy}
				aria-label={label}
				disabled={disabled || options.locked}
				onBlur={() => void save(settings)}
				onChange={(event) => {
					const next = event.target.value === "" ? undefined : Number(event.target.value)
					const field = (options.compaction ? `compaction.${key}` : key) as LocalInferenceOverrideField
					setSettings(
						markOverride(
							options.compaction
								? { ...settings, compaction: { ...settings.compaction, [key]: next } }
								: { ...settings, [key]: next },
							field,
							next !== undefined,
						),
					)
				}}
				placeholder={options.locked ? "Set context and output first" : "Server default / unknown"}
				step={samplingFields.some(([field]) => field === key) ? "any" : "1"}
				style={valueStyle(
					(options.compaction ? `compaction.${key}` : key) as LocalInferenceOverrideField,
					options.locked,
				)}
				type="number"
				value={value ?? ""}
			/>
			<span>{label}</span>
			{options.help && <span style={hint}>{options.help}</span>}
		</label>
	)
	const toggle = (label: string, checked: boolean, change: (checked: boolean) => void) => (
		<label style={{ display: "flex", alignItems: "center", gap: 6, margin: "10px 0" }}>
			<input checked={checked} disabled={disabled} onChange={(event) => change(event.target.checked)} type="checkbox" />
			{label}
		</label>
	)
	const select = (key: "supportsVision" | "supportsTools" | "supportsReasoning" | "thinking", label: string) => (
		<label key={key} style={{ display: "grid", gap: 4 }}>
			<select
				aria-label={label}
				onChange={(event) => {
					const next = markOverride(
						{ ...settings, [key]: event.target.value === "" ? undefined : event.target.value === "true" },
						key,
						event.target.value !== "",
					)
					setSettings(next)
					void save(next)
				}}
				style={valueStyle(key)}
				value={settings[key] === undefined ? "" : String(settings[key])}>
				<option value="">Server default / unknown</option>
				<option value="true">{key === "thinking" ? "On" : "Supported"}</option>
				<option value="false">{key === "thinking" ? "Off" : "Unsupported"}</option>
			</select>
			<span>{label}</span>
		</label>
	)
	return (
		<fieldset disabled={disabled} style={{ border: "none", padding: 0, marginTop: 16, minWidth: 0 }}>
			<legend style={{ fontWeight: 600 }}>Context & generation</legend>
			<p style={hint}>
				Saved per server/model. Grey italic: server/calculated defaults. Normal: your overrides. Clear a field to restore
				its default.
			</p>
			<div style={grid}>
				{numeric("contextWindow", "Total context tokens", settings.contextWindow)}
				{numeric("maxOutputTokens", "Maximum output tokens (including thinking)", settings.maxOutputTokens)}
			</div>
			<p id={budgetHelpId} style={hint}>
				Input = context − total output{counting ? " − 1 boundary token" : ""}. Output already includes thinking.
			</p>
			{toggle("Override input allowance", inputOverride, (checked) => {
				setInputOverride(checked)
				const next = markOverride(
					{ ...settings, maxInputTokens: checked ? (settings.maxInputTokens ?? automaticInput) : undefined },
					"maxInputTokens",
					checked,
				)
				setSettings(next)
				if (!checked || next.maxInputTokens !== undefined) void save(next)
			})}
			<div style={grid}>
				{numeric("maxInputTokens", "Input allowance (tokens)", inputOverride ? settings.maxInputTokens : automaticInput, {
					locked: !inputOverride,
					describedBy: budgetHelpId,
				})}
			</div>
			{inputOverride && (
				<p style={hint}>
					An override can lower the allowance; it cannot exceed the live context remaining after output is reserved.
					Effective allowance: {format(input)} tokens.
				</p>
			)}
			<h4 style={{ marginBottom: 10 }}>Thinking</h4>
			<div style={grid}>
				{select("thinking", "Thinking")}
				{numeric("thinkingBudgetTokens", "Thinking token budget", settings.thinkingBudgetTokens)}
				<label style={{ display: "grid", alignContent: "start", gap: 4 }}>
					<input
						aria-label="Reasoning effort"
						onBlur={() => void save(settings)}
						onChange={(event) =>
							setSettings(
								markOverride(
									{ ...settings, reasoningEffort: event.target.value || undefined },
									"reasoningEffort",
									!!event.target.value,
								),
							)
						}
						placeholder="Server default / unknown"
						style={valueStyle("reasoningEffort")}
						value={settings.reasoningEffort ?? ""}
					/>
					<span>Reasoning effort</span>
				</label>
			</div>
			<h4 style={{ marginBottom: 4 }}>Compaction</h4>
			<p style={hint}>Calculated from input allowance. Live prompt/tool overhead can reduce retained history.</p>
			{toggle("Override compaction settings", compactionOverride, (checked) => {
				setCompactionOverride(checked)
				const next = checked
					? markOverride(
							{
								...settings,
								compaction: { bufferTokens: DEFAULT_COMPACTION_BUFFER_TOKENS, ...settings.compaction },
							},
							"compaction.bufferTokens",
							true,
						)
					: {
							...settings,
							compaction: undefined,
							userOverrides: localInferenceUserOverrides(settings).filter((key) => !key.startsWith("compaction.")),
						}
				setSettings(next)
				void save(next)
			})}
			<div style={grid}>
				{numeric("bufferTokens", "Context safety margin (tokens)", buffer, {
					compaction: true,
					locked: !compactionOverride || !counting,
					describedBy: safetyMarginHelpId,
				})}
				{numeric("targetTokens", "Compaction target tokens", settings.compaction?.targetTokens ?? target, {
					compaction: true,
					locked: !compactionOverride,
				})}
				{numeric(
					"maxTargetTokens",
					"Maximum compaction target tokens",
					settings.compaction?.maxTargetTokens ??
						(trigger === undefined ? undefined : Math.max(1, Math.ceil(trigger) - 1)),
					{ compaction: true, locked: !compactionOverride },
				)}
				{numeric(
					"preserveRecentTokens",
					"Recent history token ceiling",
					settings.compaction?.preserveRecentTokens ??
						(target === undefined ? undefined : Math.max(0, target - (settings.maxOutputTokens ?? 8192))),
					{ compaction: true, locked: !compactionOverride },
				)}
			</div>
			<p id={safetyMarginHelpId} style={hint}>
				{counting
					? `Compaction starts at ${format(trigger)} input tokens, leaving ${format(buffer)} tokens of extra headroom.`
					: `Estimated counting compacts at 90% of input allowance (${format(trigger)} tokens); the native safety margin does not apply.`}
				{!settings.compaction?.targetTokens &&
					target !== longTarget &&
					` Automatic target: ${format(target)} tokens, or ${format(longTarget)} after five user/assistant pairs.`}{" "}
				Recent history is an upper bound for agentic compaction, before subtracting prompt/tool overhead and space for the
				summary.
			</p>
			<details style={{ marginTop: 16 }}>
				<summary style={{ cursor: "pointer", fontWeight: 600 }}>Advanced settings</summary>
				<h4>Sampling & penalties</h4>
				<div style={grid}>{samplingFields.map(([key, label]) => numeric(key, label, settings[key]))}</div>
				<h4>Model capabilities</h4>
				<div style={grid}>
					{select("supportsVision", "Image inputs")}
					{select("supportsTools", "Tool calling")}
					{select("supportsReasoning", "Reasoning support")}
				</div>
			</details>
			<p style={hint}>
				Input counting:{" "}
				{counting ? "native preflight; a counting failure stops the request" : "estimated; 2,048 tokens per image"}.
			</p>
			{!settings.maxOutputTokens && <p>Set maximum output tokens before starting a request.</p>}
			{budgetError && (
				<p role="alert" style={{ color: "var(--vscode-errorForeground)" }}>
					{budgetError}
				</p>
			)}
			{error && (
				<p role="alert" style={{ color: "var(--vscode-errorForeground)" }}>
					{error}
				</p>
			)}
		</fieldset>
	)
}
