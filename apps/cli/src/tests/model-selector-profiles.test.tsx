// @jsxImportSource @opentui/react
import { afterEach, describe, expect, it } from "bun:test";
import type { LocalModelProfileId } from "@cline/shared";
import { testRender } from "@opentui/react/test-utils";
import { DialogProvider, useDialog } from "@opentui-ui/dialog/react";
import { act, useEffect } from "react";
import {
	CHANGE_PROVIDER_ACTION,
	ModelSelectorContent,
} from "../tui/components/model-selector/model-selector";

const renderers: { destroy: () => void }[] = [];
afterEach(async () => {
	await act(async () => {
		for (const renderer of renderers.splice(0)) renderer.destroy();
	});
});
async function picker(native = true) {
	const selections: [string, LocalModelProfileId][] = [];
	const results: (string | undefined)[] = [];
	function Open() {
		const dialog = useDialog();
		useEffect(() => {
			void dialog
				.choice<string>({
					content: (ctx) => (
						<ModelSelectorContent
							{...ctx}
							currentModel="A"
							currentProviderName="Fixture"
							models={[
								{ key: "A", name: "Model A", supportsReasoning: false },
								{ key: "B", name: "Model B", supportsReasoning: true },
							]}
							modelProfiles={native ? { A: "default", B: "p2" } : undefined}
							onProfileSelect={(model, slot) => selections.push([model, slot])}
						/>
					),
				})
				.then((result) => {
					results.push(result);
				});
		}, [dialog]);
		return null;
	}
	const setup = await testRender(
		<DialogProvider>
			<Open />
		</DialogProvider>,
		{ width: 100, height: 30 },
	);
	renderers.push(setup.renderer);
	await setup.waitForFrame((frame) => frame.includes("Model A"));
	async function key(press: () => void) {
		await act(async () => {
			press();
		});
		await setup.flush();
	}
	return { ...setup, key, selections, results };
}

describe("native /model profile keyboard", () => {
	it("shows right-hand profile labels, cycles the highlighted model only, and applies on Enter", async () => {
		const ui = await picker();
		expect(ui.captureCharFrame()).toMatch(/Model A[^\n]*\[D\] P1 P2/);
		expect(ui.captureCharFrame()).toMatch(/Model B[^\n]*D P1 \[P2\]/);
		await ui.key(() => ui.mockInput.pressTab());
		expect(ui.captureCharFrame()).toMatch(/Model A[^\n]*D \[P1\] P2/);
		expect(ui.selections).toEqual([]);
		await ui.key(() => ui.mockInput.pressEnter());
		expect(ui.selections).toEqual([["A", "p1"]]);
		expect(ui.results).toEqual(["A"]);
	});
	it("discards profile drafts on Escape", async () => {
		const ui = await picker();
		await ui.key(() => ui.mockInput.pressTab());
		await ui.key(() => ui.mockInput.pressEscape());
		expect(ui.selections).toEqual([]);
		expect(ui.results).toEqual([undefined]);
	});
	it("retains provider navigation with Shift+Tab", async () => {
		const provider = await picker();
		await provider.key(() => provider.mockInput.pressTab({ shift: true }));
		await provider.key(() => provider.mockInput.pressEnter());
		expect(provider.results).toEqual([CHANGE_PROVIDER_ACTION]);
		expect(provider.selections).toEqual([]);
	});
	it("retains Tab-to-provider for other providers", async () => {
		const ui = await picker(false);
		expect(ui.captureCharFrame()).not.toContain("[D]");
		await ui.key(() => ui.mockInput.pressTab());
		await ui.key(() => ui.mockInput.pressEnter());
		expect(ui.results).toEqual([CHANGE_PROVIDER_ACTION]);
	});
});
