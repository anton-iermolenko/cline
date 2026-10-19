import { expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	packagePluginSandbox,
	verifyPackagedPluginSandbox,
} from "./package-plugin-sandbox";

test("platform bootstrap loads and runs hooks without workspace dependencies", async () => {
	const directory = mkdtempSync(join(tmpdir(), "cline-plugin-regression-"));
	const source = resolve(
		import.meta.dir,
		"../../../sdk/packages/core/dist/extensions/plugin-sandbox-bootstrap.js",
	);
	try {
		// The ordinary SDK bundle alone lacks the platform runtime sidecar.
		await expect(verifyPackagedPluginSandbox(source)).rejects.toThrow(
			"babel.cjs",
		);
		const packaged = await packagePluginSandbox({
			bootstrapSource: source,
			outputDirectory: join(directory, "extensions"),
		});
		expect(packaged).toBe(
			join(directory, "extensions/plugin-sandbox-bootstrap.js"),
		);
		const babel = join(directory, "dist/babel.cjs");
		renameSync(babel, `${babel}.saved`);
		await expect(verifyPackagedPluginSandbox(packaged)).rejects.toThrow(
			"babel.cjs",
		);
		renameSync(`${babel}.saved`, babel);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);
