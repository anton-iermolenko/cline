import type { ProviderSettingsManager } from "@cline/core";
import type { LocalModelProfileId } from "@cline/shared";
import type { Config } from "./types";

export const LOCAL_MODEL_PROFILES = [
	{ id: "default", label: "D" },
	{ id: "p1", label: "P1" },
	{ id: "p2", label: "P2" },
] as const;

export function isNativeLocalProvider(providerId: string): boolean {
	return providerId === "vllm" || providerId === "llamacpp";
}

export function nextLocalModelProfile(
	profile: LocalModelProfileId,
): LocalModelProfileId {
	const index = LOCAL_MODEL_PROFILES.findIndex((slot) => slot.id === profile);
	return (
		LOCAL_MODEL_PROFILES[(index + 1) % LOCAL_MODEL_PROFILES.length]?.id ??
		"default"
	);
}

export function readLocalModelProfiles(
	manager: Pick<ProviderSettingsManager, "getLocalModelProfileId">,
	providerId: string,
	modelIds: string[],
): Record<string, LocalModelProfileId> | undefined {
	if (!isNativeLocalProvider(providerId)) return undefined;
	return Object.fromEntries(
		modelIds.map((id) => [id, manager.getLocalModelProfileId(providerId, id)]),
	);
}

/** Commit model and slot together; a missing P1/P2 starts from that model's Default. */
export function activateLocalModelProfile(
	config: Config,
	manager: Pick<
		ProviderSettingsManager,
		"getProviderSettings" | "saveProviderSettings" | "getProviderConfig"
	>,
	modelId: string,
	profile: LocalModelProfileId,
): void {
	if (!isNativeLocalProvider(config.providerId))
		throw new Error("Model profiles require a native local provider");
	const existing = manager.getProviderSettings(config.providerId);
	if (!existing)
		throw new Error("Configure this provider before selecting a model profile");
	manager.saveProviderSettings(
		{ ...existing, model: modelId },
		{ localModelProfile: profile },
	);
	const resolved = manager.getProviderConfig(config.providerId);
	if (!resolved) throw new Error("Could not load the selected model profile");
	config.modelId = modelId;
	config.localModelProfile = profile;
	config.providerConfig = resolved;
	config.knownModels = { ...config.knownModels, ...resolved.knownModels };
	config.baseUrl = resolved.baseUrl;
	config.headers = resolved.headers;
	config.apiKey = resolved.apiKey ?? "";
	config.thinking = resolved.thinking;
	config.thinkingBudgetTokens = resolved.thinkingBudgetTokens;
	config.reasoningEffort = resolved.reasoningEffort;
}
