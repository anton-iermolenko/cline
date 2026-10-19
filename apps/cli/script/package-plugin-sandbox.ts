import { fork } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function verifyPackagedPluginSandbox(
	bootstrapPath: string,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "cline-plugin-package-"));
	const isolatedExtensions = join(directory, "extensions");
	const isolatedDist = join(directory, "dist");
	mkdirSync(isolatedExtensions);
	mkdirSync(isolatedDist);
	const isolatedBootstrap = join(isolatedExtensions, "bootstrap.mjs");
	const pluginPath = join(directory, "fixture.js");
	writeFileSync(
		pluginPath,
		'export default { name: "packaging-smoke", manifest: { capabilities: ["hooks"] }, hooks: { afterRun() { return "sandbox-ready"; } } };',
	);
	let child: ReturnType<typeof fork> | undefined;
	let stderr = "";
	try {
		copyFileSync(bootstrapPath, isolatedBootstrap);
		copyFileSync(
			join(dirname(bootstrapPath), "../dist/babel.cjs"),
			join(isolatedDist, "babel.cjs"),
		);
		child = fork(isolatedBootstrap, [], {
			cwd: directory,
			execPath: "node",
			execArgv: [],
			env: {
				...process.env,
				NODE_PATH: "",
				NODE_OPTIONS: "",
				CLINE_WRAPPER_PATH: "",
			},
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const sandbox = child;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() =>
					reject(new Error(`Plugin sandbox smoke test timed out: ${stderr}`)),
				10000,
			);
			const fail = (error: Error) => {
				clearTimeout(timeout);
				reject(error);
			};
			sandbox.once("error", fail);
			sandbox.once("exit", (code, signal) =>
				fail(
					new Error(
						`Packaged plugin sandbox exited (${code}, ${signal}): ${stderr}`,
					),
				),
			);
			sandbox.on("message", (message: unknown) => {
				const response = message as {
					type?: string;
					id?: string;
					ok?: boolean;
					error?: unknown;
					result?:
						| {
								failures?: unknown[];
								plugins?: { name: string; pluginId: string }[];
						  }
						| string;
				};
				if (response.type !== "response") return;
				if (!response.ok) {
					fail(new Error(JSON.stringify(response.error)));
					return;
				}
				if (response.id === "initialize") {
					const result = response.result;
					if (
						typeof result !== "object" ||
						result?.failures?.length ||
						result?.plugins?.length !== 1 ||
						result.plugins[0]?.name !== "packaging-smoke"
					) {
						fail(
							new Error(
								`Packaged plugin failed to initialize: ${JSON.stringify(result)}`,
							),
						);
						return;
					}
					sandbox.send({
						type: "call",
						id: "hook",
						method: "invokeHook",
						args: {
							pluginId: result.plugins[0].pluginId,
							hookName: "afterRun",
							payload: {},
						},
					});
				} else if (response.id === "hook") {
					clearTimeout(timeout);
					if (response.result !== "sandbox-ready")
						fail(new Error("Packaged plugin hook did not execute"));
					else resolve();
				}
			});
			sandbox.send({
				type: "call",
				id: "initialize",
				method: "initialize",
				args: { cwd: directory, execPath: "node", pluginPaths: [pluginPath] },
			});
		});
	} finally {
		if (child) {
			const sandbox = child;
			const exited = new Promise<void>((resolve) => {
				if (sandbox.exitCode !== null || sandbox.signalCode !== null) resolve();
				else sandbox.once("exit", () => resolve());
			});
			sandbox.kill();
			await exited;
		}
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Platform packages run this bootstrap with Node, outside the compiled Bun CLI. */
export async function packagePluginSandbox(input: {
	bootstrapSource: string;
	outputDirectory: string;
}): Promise<string> {
	mkdirSync(input.outputDirectory, { recursive: true });
	const result = await Bun.build({
		entrypoints: [input.bootstrapSource],
		outdir: input.outputDirectory,
		target: "node",
		format: "esm",
		packages: "bundle",
		external: [],
		minify: true,
		sourcemap: "none",
		splitting: false,
	});
	if (!result.success)
		throw new AggregateError(
			result.logs,
			"Failed to package the plugin sandbox",
		);
	const bootstrapPath = join(
		input.outputDirectory,
		"plugin-sandbox-bootstrap.js",
	);
	// Jiti loads its prebundled Babel transformer lazily, relative to this
	// bootstrap. It must ship even for .js plugins using import/export.
	const hostRequire = createRequire(input.bootstrapSource);
	const jitiRoot = dirname(hostRequire.resolve("jiti/package.json"));
	const distDirectory = join(input.outputDirectory, "../dist");
	mkdirSync(distDirectory, { recursive: true });
	copyFileSync(
		join(jitiRoot, "dist/babel.cjs"),
		join(distDirectory, "babel.cjs"),
	);
	await verifyPackagedPluginSandbox(bootstrapPath);
	return bootstrapPath;
}
