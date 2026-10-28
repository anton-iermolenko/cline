import { refreshLocalModelDefaults } from "@cline/core"
import { getProviderSettingsManager } from "@/sdk/provider-migration"
import { toLegacyApiProvider } from "@/shared/model-catalog/provider-helpers"
import { Empty } from "@/shared/proto/cline/common"
import { CommitModelSelectionRequest } from "@/shared/proto/cline/models"
import { getProviderModelIdKey } from "@/shared/storage/provider-keys"
import {
	hasProviderCatalogStateController,
	type ProviderCatalogController,
	parseModeRequest,
	parseProviderIdRequest,
	toModelSelection,
} from "./providerCatalogShared"

async function commitModelSelectionNow(
	controller: ProviderCatalogController,
	request: CommitModelSelectionRequest,
): Promise<Empty> {
	const providerId = parseProviderIdRequest(request.providerId)
	const mode = parseModeRequest(request.mode)
	const selection = toModelSelection(request, providerId)
	if (["vllm", "llamacpp"].includes(providerId.toString())) {
		const manager = getProviderSettingsManager()
		const config = manager.getProviderConfig(providerId.toString())
		if (config) {
			const beforeUrl = config.baseUrl
			if (!manager.hasLocalModelProfile(providerId.toString(), selection.modelId))
				await refreshLocalModelDefaults(config, selection.modelId)
			if (manager.getProviderConfig(providerId.toString())?.baseUrl !== beforeUrl)
				throw new Error("Provider URL changed during model selection; select again")
		}
	}
	const previousApiConfiguration = hasProviderCatalogStateController(controller)
		? controller.stateManager.getApiConfiguration?.()
		: undefined
	const cachedModels = controller.getProviderCatalog().peekModels(providerId)
	const baseModelInfoHint = cachedModels?.ok ? cachedModels.models.get(selection.modelId) : undefined
	if (baseModelInfoHint) {
		controller.getProviderConfigStore().commitSelection(providerId, mode, selection, baseModelInfoHint)
	} else {
		controller.getProviderConfigStore().commitSelection(providerId, mode, selection)
	}

	if (hasProviderCatalogStateController(controller)) {
		controller.stateManager.setGlobalStateBatch({
			[`${mode}ModeApiProvider`]: toLegacyApiProvider(providerId.toString()),
			[getProviderModelIdKey(toLegacyApiProvider(providerId.toString()), mode)]: selection.modelId,
		})
		await controller.stateManager.flushPendingState?.()
		const nextApiConfiguration = controller.stateManager.getApiConfiguration?.()
		if (nextApiConfiguration) {
			controller.handleApiConfigurationChanged?.(previousApiConfiguration ?? {}, nextApiConfiguration)
		}
		// A model-only commit changes state the chat view renders (the model
		// label under the input reads `apiConfiguration` from pushed state),
		// so push the updated state instead of waiting for an unrelated
		// action (e.g. sending a message) to refresh it.
		await controller.postStateToWebview?.()
	}

	return Empty.create()
}

// Serialize model switches per controller. Slow discovery never reorders commits.
const modelSwitches = new WeakMap<object, Promise<unknown>>()
export async function commitModelSelection(
	controller: ProviderCatalogController,
	request: CommitModelSelectionRequest,
): Promise<Empty> {
	const pending = (modelSwitches.get(controller) ?? Promise.resolve())
		.catch(() => {})
		.then(() => commitModelSelectionNow(controller, request))
	modelSwitches.set(controller, pending)
	try {
		return await pending
	} finally {
		if (modelSwitches.get(controller) === pending) modelSwitches.delete(controller)
	}
}
