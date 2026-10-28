import { ProviderConfigResponse } from "@shared/proto/cline/models"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { LocalInferenceSettingsForm } from "./LocalInferenceSettingsForm"

const config = (
	model = "A",
	value: Record<string, unknown> = { contextWindow: 153600, maxOutputTokens: 7000, thinkingBudgetTokens: 1500 },
) =>
	ProviderConfigResponse.create({
		providerId: "vllm",
		localInferenceModelId: model,
		localInferenceScope: "fixture-scope",
		localInferenceJson: JSON.stringify(value),
	})
describe("native model settings form", () => {
	it("renders the saved profile and saves native controls with its server/model identity", async () => {
		const write = vi.fn(
			async (_patch: { localInferenceJson: string; localInferenceModelId: string; localInferenceScope: string }) =>
				undefined,
		)
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={write} />)
		expect(screen.getByLabelText("Total context tokens")).toHaveValue(153600)
		const output = screen.getByLabelText("Maximum output tokens (including thinking)")
		fireEvent.change(output, { target: { value: "6000" } })
		fireEvent.blur(output)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		const patch = write.mock.calls[0][0] as {
			localInferenceModelId: string
			localInferenceScope: string
			localInferenceJson: string
		}
		expect(patch.localInferenceModelId).toBe("A")
		expect(patch.localInferenceScope).toBe("fixture-scope")
		expect(JSON.parse(patch.localInferenceJson)).toMatchObject({ maxOutputTokens: 6000, thinkingBudgetTokens: 1500 })
	})
	it("resets fields for a new profile and leaves undiscovered defaults unset", () => {
		const write = vi.fn(
			async (_patch: { localInferenceJson: string; localInferenceModelId: string; localInferenceScope: string }) =>
				undefined,
		)
		const view = render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={write} />)
		view.rerender(
			<LocalInferenceSettingsForm config={config("B", { contextWindow: 42000 })} selectedModelId="B" write={write} />,
		)
		expect(screen.getByLabelText("Total context tokens")).toHaveValue(42000)
		expect(screen.getByLabelText("Maximum output tokens (including thinking)")).toHaveValue(null)
		expect(screen.getByLabelText("Thinking token budget")).toHaveValue(null)
	})
	it("disables controls while the committed model differs from the selected model", () => {
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="B" write={vi.fn()} />)
		expect(screen.getByLabelText("Total context tokens")).toBeDisabled()
	})
	it("shows save failures without changing provider or hiding the error", async () => {
		const write = vi.fn(async () => {
			throw new Error("Selected model changed")
		})
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={write} />)
		fireEvent.change(screen.getByLabelText("Thinking"), { target: { value: "false" } })
		expect(await screen.findByRole("alert")).toHaveTextContent("Selected model changed")
	})
})
