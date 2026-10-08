import {
	type ProviderSettingsManager,
	readModelsFileSync,
	resolveModelsRegistryPath,
} from "@cline/core";
import type { Config } from "./types";

/**
 * The startup catalog is built from SDK manifests captured before models.json
 * is loaded. Overlay local per-model limits into the executable session config,
 * rather than relying on provider-wide fields that the extension clears.
 */
export function applyLocalModelLimits(
	config: Pick<Config, "providerId" | "modelId" | "knownModels">,
	manager: ProviderSettingsManager,
): void {
	const local = readModelsFileSync(resolveModelsRegistryPath(manager));
	const entries = local.providers[config.providerId]?.models ?? {};
	const knownModels = { ...config.knownModels };
	for (const [key, entry] of Object.entries(entries)) {
		const id = entry.id?.trim() || key.trim();
		if (!id) continue;
		const previous = knownModels[id];
		const contextWindow = entry.contextWindow ?? previous?.contextWindow;
		const maxTokens = entry.maxTokens ?? previous?.maxTokens;
		const explicitInput =
			entry.maxInputTokens ??
			(entry.contextWindow === undefined && entry.maxTokens === undefined
				? previous?.maxInputTokens
				: undefined);
		const availableInput =
			contextWindow !== undefined && maxTokens !== undefined
				? Math.max(1, contextWindow - maxTokens)
				: contextWindow;
		const maxInputTokens =
			explicitInput !== undefined && availableInput !== undefined
				? Math.min(explicitInput, availableInput)
				: (explicitInput ?? availableInput);
		knownModels[id] = {
			...previous,
			id,
			name: entry.name ?? previous?.name ?? id,
			...(contextWindow !== undefined ? { contextWindow } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
			...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
		};
	}
	config.knownModels = knownModels;
}
