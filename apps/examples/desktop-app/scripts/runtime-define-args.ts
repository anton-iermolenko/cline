import { fileURLToPath } from "node:url";
import { resolveSdkRuntimeBuildId } from "../../../../sdk/packages/core/scripts/runtime-build-id";

/** Source aliases bypass Core's dist bundle; stamp the same identity as the CLI. */
export function runtimeDefineArgs(): string[] {
	const root = fileURLToPath(new URL("../../../../", import.meta.url));
	return [
		"--define",
		`__CLINE_CORE_RUNTIME_BUILD_ID__=${JSON.stringify(resolveSdkRuntimeBuildId(root))}`,
		"--define",
		`__CLINE_CORE_RUNTIME_BUILD_EPOCH_MS__=${Date.now()}`,
	];
}
