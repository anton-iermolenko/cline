import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads, searches and reads pages using the worker embedded in a standalone binary", () => {
	const core = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
	const scratch = mkdtempSync(join(tmpdir(), "cline-embedded-web-test-"));
	try {
		const entry = join(scratch, "entry.ts");
		const build = join(scratch, "build.mts");
		const output = join(
			scratch,
			process.platform === "win32" ? "web-test.exe" : "web-test",
		);
		writeFileSync(
			entry,
			`
import { createWebPageExecutor } from ${JSON.stringify(join(core, "src/extensions/tools/web-pages.ts"))};
import assert from "node:assert/strict";
const execute = createWebPageExecutor({
 cacheDirectory: ${JSON.stringify(join(scratch, "cache"))},
 acquirePage: async (url) => ({url, requestedUrl: url, contentType: "text/html", bytes: new TextEncoder().encode("<title>Fixture</title><main><h1>Authentication</h1><p>Use a token to authenticate requests.</p></main>")}),
});
const context = {agentId: "fixture", iteration: 0, metadata: {cwd: ${JSON.stringify(scratch)}}};
// A literal public address avoids network/DNS access; acquisition returns fixture bytes.
const loaded = await execute("load", {url: "https://93.184.216.34/manual"}, context);
assert(loaded.document_id);
const found = await execute("search", {document_id: loaded.document_id, query: "authenticate"}, context);
assert(JSON.stringify(found).includes("authenticate"));
const read = await execute("read", {document_id: loaded.document_id, start_line: 1, line_count: 10}, context);
assert(JSON.stringify(read).includes("Authentication"));
console.log("embedded web worker passed");
`,
		);
		writeFileSync(
			build,
			`
const result = await Bun.build({
 entrypoints: [${JSON.stringify(entry)}], target: "bun",
 compile: {outfile: ${JSON.stringify(output)}, assets: [${JSON.stringify(join(core, "dist/plugin-runtime"))}], autoloadDotenv: false, autoloadBunfig: false, autoloadPackageJson: true},
 define: {__CLINE_PLUGIN_RUNTIME_DIR__: JSON.stringify(process.platform === "win32" ? "B:/~BUN/root/plugin-runtime" : "/$bunfs/root/plugin-runtime")},
});
if (!result.success) throw new AggregateError(result.logs, "Embedded worker build failed");
const child = Bun.spawn([${JSON.stringify(output)}], {stdout: "inherit", stderr: "inherit", env: {...process.env, BUN_BE_BUN: "", CLINE_PLUGIN_RUNTIME_DIR: "", CLINE_WEB_PAGE_WORKER_PATH: ""}});
if (await child.exited !== 0) throw new Error("Embedded worker failed");
`,
		);
		const result = execFileSync("bun", [build], {
			cwd: scratch,
			encoding: "utf8",
			timeout: 30000,
		});
		expect(result).toContain("embedded web worker passed");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 35000);
