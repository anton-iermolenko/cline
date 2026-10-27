import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	test: {
		environment: "node",
		include: ["searxng-search.test.ts"],
		testTimeout: 20_000,
	},
});
