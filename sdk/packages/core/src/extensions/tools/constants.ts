/**
 * Constants for Default Tools
 *
 * Tool name constants and utility arrays.
 */

import type { DefaultToolName } from "./types";

/**
 * Constants for default tool names
 */
export const DefaultToolNames = {
	READ_FILES: "read_files",
	SEARCH_CODEBASE: "search_codebase",
	RUN_COMMANDS: "run_commands",
	WAIT_FOR_PROCESS: "wait_for_process",
	LOAD_WEB_PAGE: "load_web_page",
	SEARCH_WEB_PAGE: "search_web_page",
	READ_WEB_PAGE_CONTENT: "read_web_page_content",
	APPLY_PATCH: "apply_patch",
	EDITOR: "editor",
	SKILLS: "skills",
	ASK: "ask_question",
	SUBMIT_AND_EXIT: "submit_and_exit",
} as const;

/**
 * Array of all default tool names
 */
export const ALL_DEFAULT_TOOL_NAMES: DefaultToolName[] = [
	DefaultToolNames.READ_FILES,
	DefaultToolNames.SEARCH_CODEBASE,
	DefaultToolNames.RUN_COMMANDS,
	DefaultToolNames.WAIT_FOR_PROCESS,
	DefaultToolNames.LOAD_WEB_PAGE,
	DefaultToolNames.SEARCH_WEB_PAGE,
	DefaultToolNames.READ_WEB_PAGE_CONTENT,
	DefaultToolNames.APPLY_PATCH,
	DefaultToolNames.EDITOR,
	DefaultToolNames.SKILLS,
	DefaultToolNames.ASK,
	DefaultToolNames.SUBMIT_AND_EXIT,
];
