import { describe, expect, it } from "vitest";
import { inheritBackgroundCommandPolicy } from "./background-command-policy";

describe("background start policy", () => {
	it("inherits shell approval requirements and disablement without mutating settings", () => {
		const policies = {
			"*": { autoApprove: true },
			run_commands: { enabled: false, autoApprove: false },
			start_background_command: { enabled: true, autoApprove: true },
		};
		expect(
			inheritBackgroundCommandPolicy(policies)?.start_background_command,
		).toMatchObject({ enabled: false, autoApprove: false });
		expect(policies.start_background_command.enabled).toBe(true);
	});
	it("retains stricter start-specific policy", () => {
		expect(
			inheritBackgroundCommandPolicy({
				run_commands: { autoApprove: true },
				start_background_command: { autoApprove: false },
			})?.start_background_command.autoApprove,
		).toBe(false);
	});
});
