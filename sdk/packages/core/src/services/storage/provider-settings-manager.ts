import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import {
	localInferenceEngine,
	type LocalModelProfileId,
	LocalModelProfileIdSchema,
	resolveLocalModelBudget,
} from "@cline/shared";
import { resolveProviderSettingsPath } from "@cline/shared/storage";
import { getProviderAuthHandler } from "../../auth/provider-auth-registry";
import { hashSecret, sdkDebug } from "../../logging/early-logger";
import {
	emptyStoredProviderSettings,
	type ProviderConfig,
	type ProviderSettings,
	ProviderSettingsSchemaTyped as ProviderSettingsSchema,
	type ProviderTokenSource,
	type StoredProviderSettings,
	StoredProviderSettingsSchema,
	type ToProviderConfigOptions,
	toProviderConfig,
	type VoiceInputSettings,
	VoiceInputSettingsSchema,
} from "../../types/provider-settings";
import { getLiveModelsCatalog } from "../llms/provider-defaults";
import {
	getLocalModelDefaults,
	localInferenceModelInfo,
	localModelProfileKey,
} from "../providers/local-inference-discovery";
import {
	applyLocalModelLimits,
	ensureCustomProvidersLoadedSync,
	registerConfiguredProvidersFromSettings,
} from "../providers/local-provider-registry";
import { migrateLegacyProviderSettings } from "./provider-settings-legacy-migration";

function nowIso(): string {
	return new Date().toISOString();
}

export interface ProviderSettingsManagerOptions {
	filePath?: string;
	dataDir?: string;
}

export interface SaveProviderSettingsOptions {
	/** Activate a saved slot for the currently selected native model. */
	localModelProfile?: LocalModelProfileId;
	setLastUsed?: boolean;
	tokenSource?: ProviderTokenSource;
}

export interface ResolveLastUsedProviderSettingsOptions {
	isClinePassEnabled?: boolean;
}

const CLINE_PROVIDER_ID = "cline";
const CLINE_PASS_PROVIDER_ID = "cline-pass";

/**
 * A pasted credential can carry invisible control or format characters (BOM,
 * zero-width spaces, bidirectional marks) that make the provider reject it
 * with a 401 indistinguishable from a genuinely wrong key — while masked
 * rendering hides the corruption from the user. Strip those characters and
 * surrounding whitespace from every credential-bearing field before the
 * value is persisted.
 */
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}]/gu;

function sanitizeSecret(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return value;
	}
	const cleaned = value.replace(INVISIBLE_CHARS, "").trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizeCredentialFields(
	settings: ProviderSettings,
): ProviderSettings {
	const next: ProviderSettings = {
		...settings,
		apiKey: sanitizeSecret(settings.apiKey),
	};
	if (settings.auth) {
		next.auth = {
			...settings.auth,
			apiKey: sanitizeSecret(settings.auth.apiKey),
			accessToken: sanitizeSecret(settings.auth.accessToken),
			refreshToken: sanitizeSecret(settings.auth.refreshToken),
		};
	}
	if (settings.aws) {
		next.aws = {
			...settings.aws,
			accessKey: sanitizeSecret(settings.aws.accessKey),
			secretKey: sanitizeSecret(settings.aws.secretKey),
			sessionToken: sanitizeSecret(settings.aws.sessionToken),
		};
	}
	if (settings.gcp) {
		next.gcp = {
			...settings.gcp,
			projectId: sanitizeSecret(settings.gcp.projectId),
			region: sanitizeSecret(settings.gcp.region),
		};
	}
	if (settings.sap) {
		next.sap = {
			...settings.sap,
			clientId: sanitizeSecret(settings.sap.clientId),
			clientSecret: sanitizeSecret(settings.sap.clientSecret),
		};
	}
	if (settings.headers) {
		next.headers = Object.fromEntries(
			Object.entries(settings.headers).map(([name, value]) => [
				name,
				value.replace(INVISIBLE_CHARS, "").trim(),
			]),
		);
	}
	return next;
}

function inferLegacyDataDir(filePath: string): string | undefined {
	if (basename(filePath) !== "providers.json") {
		return undefined;
	}
	const settingsDir = dirname(filePath);
	if (basename(settingsDir) !== "settings") {
		return undefined;
	}
	return dirname(settingsDir);
}

export class ProviderSettingsManager {
	private readonly filePath: string;
	private readonly dataDir?: string;

	constructor(options: ProviderSettingsManagerOptions = {}) {
		this.filePath = options.filePath ?? resolveProviderSettingsPath();
		this.dataDir = options.dataDir ?? inferLegacyDataDir(this.filePath);
		if (this.dataDir || !options.filePath) {
			migrateLegacyProviderSettings({
				providerSettingsManager: this,
				dataDir: this.dataDir,
			});
		}
		ensureCustomProvidersLoadedSync(this);
		registerConfiguredProvidersFromSettings(this.read());
		// Harden permissions on any existing file at startup so that
		// pre-existing installations are also protected (best-effort; no-op on Windows).
		if (existsSync(this.filePath)) {
			try {
				chmodSync(this.filePath, 0o600);
			} catch {
				// Ignore — Windows does not support POSIX chmod.
			}
		}
	}

	getFilePath(): string {
		return this.filePath;
	}

	read(): StoredProviderSettings {
		if (!existsSync(this.filePath)) {
			return emptyStoredProviderSettings();
		}

		try {
			const raw = readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			const result = StoredProviderSettingsSchema.safeParse(parsed);
			if (result.success) {
				registerConfiguredProvidersFromSettings(result.data);
				const clineAuth = result.data.providers["cline"]?.settings?.auth;
				sdkDebug(
					`providers.read providers=[${Object.keys(result.data.providers).join(",")}] lastUsed=${result.data.lastUsedProvider ?? "none"} clineAuthPresent=${!!clineAuth?.accessToken} clineAccessTokenHash=${hashSecret(clineAuth?.accessToken)} clineRefreshTokenHash=${hashSecret(clineAuth?.refreshToken)}`,
				);
				return result.data;
			}
		} catch {
			// Invalid content falls back to a clean state.
		}

		return emptyStoredProviderSettings();
	}

	write(state: StoredProviderSettings): void {
		const normalized = StoredProviderSettingsSchema.parse(state);
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		// Stage to a pid-unique temp file and rename into place. Concurrent
		// Cline processes (CLI, extension, hub) share this file; a bare
		// writeFileSync lets readers catch a partial file, which read() treats
		// as empty settings — indistinguishable from being logged out.
		const tempPath = `${this.filePath}.${process.pid}.tmp`;
		try {
			writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			renameSync(tempPath, this.filePath);
		} catch (error) {
			rmSync(tempPath, { force: true });
			throw error;
		}
		// Restrict file to owner-only read/write (best-effort; no-op on Windows).
		try {
			chmodSync(this.filePath, 0o600);
		} catch {
			// Ignore — Windows does not support POSIX chmod.
		}
		registerConfiguredProvidersFromSettings(normalized);
	}

	saveProviderSettings(
		settings: unknown,
		options: SaveProviderSettingsOptions = {},
	): StoredProviderSettings {
		const validatedSettings = sanitizeCredentialFields(
			ProviderSettingsSchema.parse(settings),
		);
		const previous = this.read();
		const providerId = validatedSettings.provider;
		const shouldSetLastUsed = options.setLastUsed !== false;
		const previousEntry = previous.providers[providerId];
		const localModelProfiles = { ...previousEntry?.localModelProfiles };
		const localModelProfileSlots = structuredClone(
			previousEntry?.localModelProfileSlots ?? {},
		);
		if (
			options.localModelProfile !== undefined &&
			!localInferenceEngine(providerId)
		)
			throw new Error("Model profiles require a native local provider");
		if (localInferenceEngine(providerId)) {
			const old = previousEntry?.settings;
			const oldKey = old?.model
				? localModelProfileKey(old.baseUrl, old.model)
				: undefined;
			if (old && oldKey) {
				const selected = localModelProfileSlots[oldKey]?.selected ?? "default";
				if (selected === "default")
					localModelProfiles[oldKey] = old.localInference ?? {};
				else
					localModelProfileSlots[oldKey][selected] = old.localInference ?? {};
			}
			if (validatedSettings.model) {
				const model = validatedSettings.model;
				const key = localModelProfileKey(
					validatedSettings.baseUrl,
					validatedSettings.model,
				);
				const slots = localModelProfileSlots[key] ?? {
					selected: "default" as const,
				};
				const selected =
					options.localModelProfile !== undefined
						? LocalModelProfileIdSchema.parse(options.localModelProfile)
						: slots.selected;
				const modelChanged = oldKey !== key;
				const slotChanged = selected !== slots.selected;
				const defaults = () =>
					localModelProfiles[key] ??
					getLocalModelDefaults(validatedSettings.baseUrl, model, providerId) ??
					{};
				if (
					(modelChanged && oldKey !== undefined) ||
					slotChanged ||
					!validatedSettings.localInference
				) {
					validatedSettings.localInference = structuredClone(
						selected === "default"
							? defaults()
							: (slots[selected] ?? defaults()),
					);
					delete validatedSettings.reasoning;
					delete validatedSettings.maxTokens;
					delete validatedSettings.contextWindow;
				}
				if (options.localModelProfile !== undefined)
					resolveLocalModelBudget({
						...getLocalModelDefaults(
							validatedSettings.baseUrl,
							validatedSettings.model,
							providerId,
						),
						...validatedSettings.localInference,
					});
				if (selected === "default")
					localModelProfiles[key] = validatedSettings.localInference;
				else slots[selected] = validatedSettings.localInference;
				slots.selected = selected;
				if (selected !== "default" || localModelProfileSlots[key])
					localModelProfileSlots[key] = slots;
			} else {
				if (options.localModelProfile !== undefined)
					throw new Error("Select a model before activating its profile");
				if (old?.baseUrl !== validatedSettings.baseUrl)
					delete validatedSettings.localInference;
			}
		}
		const tokenSource =
			options.tokenSource ?? previousEntry?.tokenSource ?? "manual";
		const next: StoredProviderSettings = {
			...previous,
			providers: {
				...previous.providers,
				[providerId]: {
					settings: validatedSettings,
					...(localInferenceEngine(providerId)
						? {
								localModelProfiles,
								...(Object.keys(localModelProfileSlots).length
									? { localModelProfileSlots }
									: {}),
							}
						: {}),
					updatedAt: nowIso(),
					tokenSource,
				},
			},
			lastUsedProvider: shouldSetLastUsed
				? providerId
				: previous.lastUsedProvider,
		};
		this.write(next);
		const prevClineAuth = previous.providers["cline"]?.settings?.auth;
		const nextClineAuth =
			validatedSettings.provider === "cline"
				? validatedSettings.auth
				: next.providers["cline"]?.settings?.auth;
		const authDropped =
			!!prevClineAuth?.accessToken && !nextClineAuth?.accessToken;
		sdkDebug(
			`providers.save providerId=${providerId} tokenSource=${tokenSource} clineAuthWasPresent=${!!prevClineAuth?.accessToken} clineAuthIsPresent=${!!nextClineAuth?.accessToken} authDropped=${authDropped}`,
		);
		return next;
	}

	private resolveProviderSettings(
		state: StoredProviderSettings,
		providerId: string,
	): ProviderSettings | undefined {
		const directSettings = state.providers[providerId]?.settings;
		const authHandler = getProviderAuthHandler(providerId);
		const storageProviderId = authHandler?.storageProviderId;
		if (!storageProviderId || storageProviderId === providerId) {
			return directSettings;
		}

		const authSettings = state.providers[storageProviderId]?.settings;
		if (!authSettings) {
			return directSettings;
		}

		return ProviderSettingsSchema.parse({
			...(authSettings.auth ? { auth: authSettings.auth } : {}),
			...(authSettings.apiKey ? { apiKey: authSettings.apiKey } : {}),
			...(authSettings.baseUrl ? { baseUrl: authSettings.baseUrl } : {}),
			...(directSettings ?? {}),
			provider: providerId,
		});
	}

	getProviderSettings(providerId: string): ProviderSettings | undefined {
		const state = this.read();
		return this.resolveProviderSettings(state, providerId);
	}

	getVoiceInputSettings(): VoiceInputSettings | undefined {
		return this.read().modes.voiceInput;
	}

	setVoiceInputSettings(
		settings: VoiceInputSettings | undefined,
	): StoredProviderSettings {
		const state = this.read();
		if (settings) {
			state.modes.voiceInput = VoiceInputSettingsSchema.parse(settings);
		} else {
			delete state.modes.voiceInput;
		}
		this.write(state);
		return state;
	}

	private resolveLastUsedProviderId(
		state: StoredProviderSettings,
		options: ResolveLastUsedProviderSettingsOptions,
	): string | undefined {
		const providerId = state.lastUsedProvider;
		if (
			providerId === CLINE_PASS_PROVIDER_ID &&
			options.isClinePassEnabled === false
		) {
			return CLINE_PROVIDER_ID;
		}

		return providerId;
	}

	getLastUsedProviderSettings(
		options: ResolveLastUsedProviderSettingsOptions = {},
	): ProviderSettings | undefined {
		const state = this.read();
		const providerId = this.resolveLastUsedProviderId(state, options);
		if (!providerId) {
			return undefined;
		}
		return this.resolveProviderSettings(state, providerId);
	}

	getLocalModelProfileId(
		providerId: string,
		modelId?: string,
	): LocalModelProfileId {
		const entry = this.read().providers[providerId];
		const model = modelId ?? entry?.settings.model;
		return entry && model && localInferenceEngine(providerId)
			? (entry.localModelProfileSlots?.[
					localModelProfileKey(entry.settings.baseUrl, model)
				]?.selected ?? "default")
			: "default";
	}

	hasLocalModelProfile(providerId: string, modelId: string): boolean {
		const entry = this.read().providers[providerId];
		return Boolean(
			entry?.localModelProfiles?.[
				localModelProfileKey(entry.settings.baseUrl, modelId)
			],
		);
	}

	getLocalModelSettings(
		providerId: string,
		modelId: string,
	): import("@cline/shared").LocalInferenceSettings | undefined {
		const entry = this.read().providers[providerId];
		if (!entry || !localInferenceEngine(providerId)) return undefined;
		if (entry.settings.model === modelId) return entry.settings.localInference;
		const key = localModelProfileKey(entry.settings.baseUrl, modelId);
		const slots = entry.localModelProfileSlots?.[key];
		return (
			(slots && slots.selected !== "default"
				? slots[slots.selected]
				: entry.localModelProfiles?.[key]) ??
			getLocalModelDefaults(entry.settings.baseUrl, modelId, providerId)
		);
	}

	getProviderConfig(
		providerId: string,
		options?: ToProviderConfigOptions,
	): ProviderConfig | undefined {
		const settings = this.getProviderSettings(providerId);
		if (!settings) {
			return undefined;
		}
		const defaults =
			localInferenceEngine(providerId) && settings.model
				? getLocalModelDefaults(settings.baseUrl, settings.model, providerId)
				: undefined;
		const localInference =
			settings.localInference || defaults
				? {
						...defaults,
						...settings.localInference,
						serverDefaults:
							defaults?.serverDefaults ??
							settings.localInference?.serverDefaults,
					}
				: undefined;
		const config = toProviderConfig({ ...settings, localInference }, options);
		applyLocalModelLimits(config, this);
		if (localInferenceEngine(providerId) && settings.model) {
			const local = config.localInference ?? {};
			const previousModel = config.knownModels?.[settings.model];
			config.knownModels = {
				...config.knownModels,
				[settings.model]: localInferenceModelInfo(
					settings.model,
					local,
					previousModel,
				),
			};
		}
		if (options?.includeKnownModels === false) delete config.knownModels;
		return config;
	}

	getLastUsedProviderConfig(
		options: ToProviderConfigOptions &
			ResolveLastUsedProviderSettingsOptions = {},
	): ProviderConfig | undefined {
		const settings = this.getLastUsedProviderSettings(options);
		if (!settings) {
			return undefined;
		}
		return this.getProviderConfig(settings.provider, options);
	}

	async refreshCatalog(): Promise<void> {
		try {
			await getLiveModelsCatalog({});
		} catch {
			// Ignore errors
		}
	}
}
