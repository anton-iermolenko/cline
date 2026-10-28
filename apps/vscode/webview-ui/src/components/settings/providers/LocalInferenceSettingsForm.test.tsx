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

describe("automatic local model budgets", () => {
	it("groups sampling and penalties in a collapsed Advanced section", () => {
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={vi.fn()} />)
		const advanced = screen.getByText("Advanced settings").closest("details")!
		expect(advanced).not.toHaveAttribute("open")
		expect(advanced).toContainElement(screen.getByLabelText("Temperature"))
		expect(advanced).toContainElement(screen.getByLabelText("Frequency penalty"))
	})
	it("shows disabled calculated limits that follow output without saving computed overrides", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={write} />)
		const input = screen.getByLabelText("Input allowance (tokens)")
		expect(input).toBeDisabled()
		expect(input).toHaveValue(146599)
		expect(screen.getByLabelText("Compaction target tokens")).toBeDisabled()
		expect(screen.getByLabelText("Compaction target tokens")).toHaveValue(101185)
		const output = screen.getByLabelText("Maximum output tokens (including thinking)")
		fireEvent.change(output, { target: { value: "10000" } })
		expect(input).toHaveValue(143599)
		expect(screen.getByLabelText("Compaction target tokens")).toHaveValue(99085)
		fireEvent.blur(output)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		const patch = write.mock.calls[0][0] as { localInferenceJson: string }
		const saved = JSON.parse(patch.localInferenceJson)
		expect(saved).not.toHaveProperty("maxInputTokens")
		expect(saved).not.toHaveProperty("compaction")
	})
	it("unlocks manual overrides and clearing them restores automatic values", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		render(
			<LocalInferenceSettingsForm
				config={config("A", {
					contextWindow: 153600,
					maxOutputTokens: 7000,
					maxInputTokens: 90000,
					compaction: { bufferTokens: 1000, targetTokens: 40000 },
				})}
				selectedModelId="A"
				write={write}
			/>,
		)
		expect(screen.getByLabelText("Override input allowance")).toBeChecked()
		expect(screen.getByLabelText("Input allowance (tokens)")).toBeEnabled()
		expect(screen.getByLabelText("Override compaction settings")).toBeChecked()
		fireEvent.click(screen.getByLabelText("Override input allowance"))
		await waitFor(() => expect(screen.getByLabelText("Override compaction settings")).toBeEnabled())
		expect(screen.getByLabelText("Input allowance (tokens)")).toHaveValue(146599)
		fireEvent.click(screen.getByLabelText("Override compaction settings"))
		await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
		const saved = JSON.parse((write.mock.calls[1][0] as { localInferenceJson: string }).localInferenceJson)
		expect(saved).not.toHaveProperty("maxInputTokens")
		expect(saved).not.toHaveProperty("compaction")
		expect(screen.getByLabelText("Compaction target tokens")).toBeDisabled()
		expect(screen.getByLabelText("Context safety margin (tokens)")).toHaveValue(2048)
	})
	it("keeps missing capacities unknown and flags output/thinking conflicts", () => {
		const view = render(<LocalInferenceSettingsForm config={config("A", {})} selectedModelId="A" write={vi.fn()} />)
		expect(screen.getByLabelText("Input allowance (tokens)")).toHaveValue(null)
		expect(screen.getByLabelText("Compaction target tokens")).toHaveValue(null)
		view.rerender(
			<LocalInferenceSettingsForm
				config={config("B", { contextWindow: 100, maxOutputTokens: 50, thinkingBudgetTokens: 50 })}
				selectedModelId="B"
				write={vi.fn()}
			/>,
		)
		expect(screen.getByRole("alert")).toHaveTextContent("Thinking must leave room")
	})
	it("shows the estimator trigger without offering a native margin override", () => {
		render(
			<LocalInferenceSettingsForm
				config={config("A", { contextWindow: 10000, maxOutputTokens: 1000, inputTokenCounting: false })}
				selectedModelId="A"
				write={vi.fn()}
			/>,
		)
		expect(screen.getByLabelText("Input allowance (tokens)")).toHaveValue(9000)
		expect(screen.getByText(/Estimated counting compacts at 90%/)).toHaveTextContent("8,100")
	})
})

describe("server defaults and explicit edits", () => {
	it("shows defaults in grey italic and preserves same-value user overrides across model switches", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		const view = render(
			<LocalInferenceSettingsForm
				config={config("A", { contextWindow: 10000, maxOutputTokens: 1000, temperature: 0.7, userOverrides: [] })}
				selectedModelId="A"
				write={write}
			/>,
		)
		expect(screen.getByLabelText("Total context tokens")).toHaveStyle({ fontStyle: "italic" })
		const temperature = screen.getByLabelText("Temperature")
		expect(temperature).toHaveStyle({ fontStyle: "italic" })
		fireEvent.change(temperature, { target: { value: "0.8" } })
		fireEvent.change(temperature, { target: { value: "0.7" } })
		expect(temperature).toHaveStyle({ fontStyle: "normal" })
		fireEvent.blur(temperature)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		const saved = JSON.parse((write.mock.calls[0][0] as { localInferenceJson: string }).localInferenceJson)
		expect(saved.userOverrides).toContain("temperature")
		view.rerender(
			<LocalInferenceSettingsForm
				config={config("B", { contextWindow: 20000, userOverrides: [] })}
				selectedModelId="B"
				write={write}
			/>,
		)
		view.rerender(<LocalInferenceSettingsForm config={config("A", saved)} selectedModelId="A" write={write} />)
		expect(screen.getByLabelText("Temperature")).toHaveStyle({ fontStyle: "normal" })
		expect(screen.getByLabelText("Total context tokens")).toHaveStyle({ fontStyle: "italic" })
		fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "" } })
		fireEvent.blur(screen.getByLabelText("Temperature"))
		await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
		const cleared = JSON.parse((write.mock.calls[1][0] as { localInferenceJson: string }).localInferenceJson)
		expect(cleared.userOverrides).not.toContain("temperature")
		expect(cleared).not.toHaveProperty("temperature")
	})
})
