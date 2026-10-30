import { describe, expect, it } from "vitest";
import { getConnector, listConnectors } from "./registry";

describe("connector registry", () => {
	// Loading the real adapter also loads the SDK; this checks registration, not speed.
	it("registers the Discord connector", async () => {
		expect(listConnectors().map((connector) => connector.name)).toContain(
			"discord",
		);

		await expect(getConnector("discord")).resolves.toMatchObject({
			name: "discord",
		});
	}, 30000);
});
