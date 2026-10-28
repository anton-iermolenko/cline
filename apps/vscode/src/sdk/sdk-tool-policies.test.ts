import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { describe, expect, it } from "vitest"
import { isToolAutoApproved } from "./sdk-tool-policies"

describe("isToolAutoApproved", () => {
	it("does not auto-approve command tools by default", () => {
		expect(isToolAutoApproved("run_commands", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(false)
	})

	it("uses executeSafeCommands as the single command approval flag", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
				executeSafeCommands: false,
				executeAllCommands: true,
			},
		}

		expect(isToolAutoApproved("run_commands", settings)).toBe(false)
	})

	it("auto-approves all MCP tools when the Use MCP servers toggle is on", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: true },
		}

		expect(isToolAutoApproved("firecrawl__scrape", settings)).toBe(true)
	})

	it("prompts for MCP tools when the Use MCP servers toggle is off", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: false },
		}

		expect(isToolAutoApproved("firecrawl__scrape", settings)).toBe(false)
	})
})

describe("bounded web tool approval", () => {
	for (const tool of ["load_web_page", "search_web_page", "read_web_page_content", "web_search"]) {
		it(`${tool} follows the browser approval toggle`, () => {
			for (const enabled of [true, false]) {
				expect(
					isToolAutoApproved(tool, {
						...DEFAULT_AUTO_APPROVAL_SETTINGS,
						actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useBrowser: enabled },
					}),
				).toBe(enabled)
			}
		})
	}
})

describe("native staged edit approval", () => {
	for (const tool of ["editor", "apply_draft", "create_from_draft"]) {
		it(`${tool} follows edit approval rather than MCP approval`, () => {
			for (const enabled of [true, false])
				expect(
					isToolAutoApproved(tool, {
						...DEFAULT_AUTO_APPROVAL_SETTINGS,
						actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, editFiles: enabled, useMcp: !enabled },
					}),
				).toBe(enabled)
		})
	}
})
