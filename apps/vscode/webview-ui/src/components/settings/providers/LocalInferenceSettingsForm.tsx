import type { LocalInferenceSettings } from "@cline/shared"
import type { ProviderConfigResponse } from "@shared/proto/cline/models"
import { useEffect, useId, useState } from "react"

const numericFields = [
	["contextWindow", "Total context tokens"],
	["maxInputTokens", "Input cap (optional)"],
	["maxOutputTokens", "Maximum output tokens (including thinking)"],
	["thinkingBudgetTokens", "Thinking token budget"],
	["temperature", "Temperature"],
	["topP", "Top P"],
	["topK", "Top K"],
	["minP", "Min P"],
	["repeatPenalty", "Repeat penalty"],
	["presencePenalty", "Presence penalty"],
	["frequencyPenalty", "Frequency penalty"],
] as const
const compactionFields = [
	["bufferTokens", "Context safety margin (tokens)"],
	["targetTokens", "Compaction target tokens"],
	["maxTargetTokens", "Maximum compaction target tokens"],
	["preserveRecentTokens", "Recent tokens to preserve"],
] as const

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
	const safetyMarginHelpId = useId()
	useEffect(() => {
		setSettings(config?.localInferenceJson ? (JSON.parse(config.localInferenceJson) as LocalInferenceSettings) : {})
		setError(undefined)
	}, [config?.localInferenceJson, config?.localInferenceModelId])
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
	const numberInput = (key: string, label: string, value: number | undefined, compaction = false) => (
		<label key={key} style={{ display: "grid", gap: 4, marginBottom: 10 }}>
			{label}
			<input
				aria-describedby={compaction && key === "bufferTokens" ? safetyMarginHelpId : undefined}
				aria-label={label}
				disabled={disabled}
				onBlur={() => void save(settings)}
				onChange={(event) => {
					const value = event.target.value === "" ? undefined : Number(event.target.value)
					setSettings((current) =>
						compaction
							? { ...current, compaction: { ...current.compaction, [key]: value } }
							: { ...current, [key]: value },
					)
				}}
				placeholder="Server default / unknown"
				step="any"
				style={{
					color: "var(--vscode-input-foreground)",
					background: "var(--vscode-input-background)",
					border: "1px solid var(--vscode-input-border)",
					padding: 6,
				}}
				type="number"
				value={value ?? ""}
			/>
			{compaction && key === "bufferTokens" && (
				<span id={safetyMarginHelpId} style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12 }}>
					Extra room below the input limit before compaction starts. Output tokens are reserved separately.
				</span>
			)}
		</label>
	)
	return (
		<fieldset disabled={disabled} style={{ border: "none", padding: 0, marginTop: 12 }}>
			<legend>Model settings</legend>
			<p>Settings are saved for this model. Empty fields use reported server defaults or remain unknown.</p>
			{numericFields.map(([key, label]) => numberInput(key, label, settings[key]))}
			{(
				[
					["supportsVision", "Image inputs"],
					["supportsTools", "Tool calling"],
					["supportsReasoning", "Reasoning support"],
				] as const
			).map(([key, label]) => (
				<label key={key} style={{ display: "grid", gap: 4, marginBottom: 10 }}>
					{label}
					<select
						aria-label={label}
						onChange={(event) => {
							const next = {
								...settings,
								[key]: event.target.value === "" ? undefined : event.target.value === "true",
							}
							setSettings(next)
							void save(next)
						}}
						value={settings[key] === undefined ? "" : String(settings[key])}>
						<option value="">Server default / unknown</option>
						<option value="true">Supported</option>
						<option value="false">Unsupported</option>
					</select>
				</label>
			))}
			<label style={{ display: "grid", gap: 4, marginBottom: 10 }}>
				Thinking
				<select
					aria-label="Thinking"
					onChange={(event) => {
						const next = {
							...settings,
							thinking: event.target.value === "" ? undefined : event.target.value === "true",
						}
						setSettings(next)
						void save(next)
					}}
					value={settings.thinking === undefined ? "" : String(settings.thinking)}>
					<option value="">Server default / unknown</option>
					<option value="true">On</option>
					<option value="false">Off</option>
				</select>
			</label>
			<label style={{ display: "grid", gap: 4, marginBottom: 10 }}>
				Reasoning effort
				<input
					aria-label="Reasoning effort"
					onBlur={() => void save(settings)}
					onChange={(event) => setSettings({ ...settings, reasoningEffort: event.target.value || undefined })}
					placeholder="Server default / unknown"
					value={settings.reasoningEffort ?? ""}
				/>
			</label>
			<details>
				<summary>Compaction settings</summary>
				{compactionFields.map(([key, label]) => numberInput(key, label, settings.compaction?.[key], true))}
			</details>
			<p>
				Input counting:{" "}
				{settings.inputTokenCounting === false
					? "estimated; 2,048 tokens per image"
					: "native preflight; counting errors stop the request"}
				.
			</p>
			{!settings.maxOutputTokens && <p>Set maximum output tokens before starting a request.</p>}
			{error && (
				<p role="alert" style={{ color: "var(--vscode-errorForeground)" }}>
					{error}
				</p>
			)}
		</fieldset>
	)
}
