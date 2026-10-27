import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPersistedMessagesFile } from "./runtime-host-support";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.allSettled(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("readPersistedMessagesFile", () => {
	it.each([
		'{"messages":[',
		'{"messages":[]} trailing-private-content',
	])("reports damaged JSON without exposing saved content", async (raw) => {
		const dir = await mkdtemp(join(tmpdir(), "runtime-host-support-"));
		tempDirs.push(dir);
		const messagesPath = join(dir, "messages.json");
		await writeFile(messagesPath, raw);
		await expect(readPersistedMessagesFile(messagesPath)).rejects.toThrow(
			/^The saved conversation transcript contains invalid JSON\.$/,
		);
	});

	it("distinguishes unsupported formats from empty or missing history", async () => {
		const dir = await mkdtemp(join(tmpdir(), "runtime-host-support-"));
		tempDirs.push(dir);
		const messagesPath = join(dir, "messages.json");
		await writeFile(messagesPath, JSON.stringify({ messages: null }));
		await expect(readPersistedMessagesFile(messagesPath)).rejects.toThrow(
			"unsupported format",
		);
		await writeFile(messagesPath, JSON.stringify({ messages: [] }));
		await expect(readPersistedMessagesFile(messagesPath)).resolves.toEqual([]);
		await expect(
			readPersistedMessagesFile(join(dir, "missing.json")),
		).resolves.toEqual([]);
		await expect(readPersistedMessagesFile()).resolves.toEqual([]);
		await expect(readPersistedMessagesFile(dir)).rejects.toThrow(
			"could not be read",
		);
	});

	it("returns persisted messages verbatim, wrappers included", async () => {
		// The user_input wrapper records which mode each message was sent in
		// and session restarts re-seed through this read path, so stripping
		// here would destroy that history a little more on every restart.
		// Display surfaces format for themselves via formatDisplayUserInput.
		const dir = await mkdtemp(join(tmpdir(), "runtime-host-support-"));
		tempDirs.push(dir);
		const messagesPath = join(dir, "messages.json");
		await writeFile(
			messagesPath,
			JSON.stringify([
				{
					role: "user",
					content: '<user_input mode="act">spawn a team of agents</user_input>',
				},
				{
					role: "assistant",
					content: "Working on it.",
				},
				{
					role: "user",
					content: [
						{
							type: "text",
							text: '<user_input mode="plan"><mode_notice>The user switched from act mode to plan mode before sending this message.</mode_notice>\ninspect repo</user_input>',
						},
					],
				},
			]),
			"utf8",
		);

		const messages = await readPersistedMessagesFile(messagesPath);

		expect(messages[0]?.content).toBe(
			'<user_input mode="act">spawn a team of agents</user_input>',
		);
		expect(messages[1]?.content).toBe("Working on it.");
		expect(messages[2]?.content).toEqual([
			{
				type: "text",
				text: '<user_input mode="plan"><mode_notice>The user switched from act mode to plan mode before sending this message.</mode_notice>\ninspect repo</user_input>',
			},
		]);
	});
});
