import type { ModelInfo } from "@shared/api"
import type { ProviderModelOverrides } from "@shared/proto-conversions/models/modelOverrides"
import { useEffect, useState } from "react"

const priceFields = [
	["inputPrice", "Input cost"],
	["outputPrice", "Output cost"],
	["cacheReadsPrice", "Cache read cost"],
	["cacheWritesPrice", "Cache write cost"],
] as const

type PriceField = (typeof priceFields)[number][0]
const draftPrices = (modelInfo: Pick<ModelInfo, PriceField>) =>
	Object.fromEntries(priceFields.map(([field]) => [field, modelInfo[field]?.toString() ?? ""])) as Record<PriceField, string>

export function LocalModelCostSettings({
	modelInfo,
	overrides,
	onSave,
	disabled,
}: {
	modelInfo: ModelInfo
	overrides?: ProviderModelOverrides
	onSave: (overrides: ProviderModelOverrides) => Promise<unknown>
	disabled?: boolean
}) {
	const [draft, setDraft] = useState(() => draftPrices(modelInfo))
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState("")
	const { inputPrice, outputPrice, cacheReadsPrice, cacheWritesPrice } = modelInfo
	useEffect(() => {
		setDraft(draftPrices({ inputPrice, outputPrice, cacheReadsPrice, cacheWritesPrice }))
	}, [inputPrice, outputPrice, cacheReadsPrice, cacheWritesPrice])

	const savePrice = async (field: PriceField) => {
		const text = draft[field].trim()
		const value = text === "" ? undefined : Number(text)
		if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
			setError("Enter a non-negative cost in USD per million tokens.")
			return
		}
		if (value === modelInfo[field] || (value === undefined && overrides?.[field] === undefined)) return
		const next = { ...overrides }
		if (value === undefined) delete next[field]
		else next[field] = value
		setSaving(true)
		setError("")
		try {
			await onSave(next)
		} catch {
			setError("Could not save cost estimates. Try again.")
		} finally {
			setSaving(false)
		}
	}

	return (
		<section aria-label="Token cost estimates" style={{ marginTop: 16 }}>
			<h4 style={{ marginBottom: 8 }}>Token cost estimates (USD per million tokens)</h4>
			<div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px 16px" }}>
				{priceFields
					.filter(
						([field]) =>
							!field.startsWith("cache") || modelInfo.supportsPromptCache || modelInfo[field] !== undefined,
					)
					.map(([field, label]) => (
						<label key={field} style={{ minWidth: 0 }}>
							<input
								aria-label={label}
								disabled={disabled || saving}
								min={0}
								onBlur={() => void savePrice(field)}
								onChange={(event) => setDraft((previous) => ({ ...previous, [field]: event.target.value }))}
								placeholder="Not set"
								step="any"
								style={{
									width: "100%",
									minWidth: 0,
									boxSizing: "border-box",
									padding: 6,
									background: "var(--vscode-input-background)",
									border: "1px solid var(--vscode-input-border)",
									color:
										overrides?.[field] === undefined
											? "var(--vscode-descriptionForeground)"
											: "var(--vscode-input-foreground)",
									fontStyle: overrides?.[field] === undefined ? "italic" : "normal",
								}}
								type="number"
								value={draft[field]}
							/>
							<div style={{ marginTop: 4 }}>{label}</div>
						</label>
					))}
			</div>
			{error && <p role="alert">{error}</p>}
		</section>
	)
}
