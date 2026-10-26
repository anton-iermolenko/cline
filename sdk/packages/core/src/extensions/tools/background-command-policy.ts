import type { ToolPolicy } from "@cline/shared";

/** Starting a managed command must not weaken an existing shell policy. */
export function inheritBackgroundCommandPolicy(
	policies: Record<string, ToolPolicy> | undefined,
): Record<string, ToolPolicy> | undefined {
	const shell = policies?.run_commands;
	if (!shell) return policies;
	const start = policies?.start_background_command;
	return {
		...policies,
		start_background_command: {
			...shell,
			...start,
			...(shell.enabled === false ? { enabled: false } : {}),
			...(shell.autoApprove === false ? { autoApprove: false } : {}),
		},
	};
}
