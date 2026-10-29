import { ProviderConfigResponse } from "@shared/proto/cline/models"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { LocalInferenceSettingsForm } from "./LocalInferenceSettingsForm"

const defaults = {
	contextWindow: 150000,
	maxOutputTokens: 8000,
	serverDefaults: { contextWindow: 150000, maxOutputTokens: 8000 },
	userOverrides: [],
}
const config = (model = "A", value: Record<string, unknown> = defaults) =>
	ProviderConfigResponse.create({
		providerId: "vllm",
		localInferenceModelId: model,
		localInferenceScope: "fixture-scope",
		localInferenceJson: JSON.stringify(value),
	})
const parse = (patch: unknown) => JSON.parse((patch as { localInferenceJson: string }).localInferenceJson)
describe("continuous native model budgets", () => {
	it("shows disabled defaults and an estimated complete allocation", () => {
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={vi.fn()} />)
		expect(screen.getByLabelText("Maximum context size (tokens)")).toBeDisabled()
		expect(screen.getByLabelText("Normal output tokens (including thinking)")).toHaveValue(8000)
		expect(screen.getByLabelText("Compaction target tokens")).toHaveValue(64000)
		expect(screen.getByLabelText("Summarized history tokens")).toHaveValue(14000)
		expect(screen.getByLabelText("Summarized history tokens")).toHaveStyle({ fontStyle: "italic" })
		expect(screen.getByRole("region", { name: "Context budget breakdown" })).toHaveTextContent("40,000")
		expect(screen.getByRole("region", { name: "Context budget breakdown" })).toHaveTextContent("141,871")
		expect(screen.getByRole("region", { name: "Context budget breakdown" })).toHaveTextContent("121,871")
		expect(screen.getByText("Minimum iteration reserve").nextElementSibling).toHaveTextContent("20,000")
		expect(screen.getByText("Additional iteration space").nextElementSibling).toHaveTextContent("57,871")
		expect(screen.getByText("Total iteration space").nextElementSibling).toHaveTextContent("77,871")
		expect(screen.getByText("Counting margin + boundary").nextElementSibling).toHaveTextContent("129")
		expect(screen.queryByText(/Hard cap =/)).not.toBeInTheDocument()
		expect(screen.queryByText(/This is a planning allocation/)).not.toBeInTheDocument()
		expect(screen.queryByText(/The compaction target includes/)).not.toBeInTheDocument()
		expect(screen.queryByText(/five user\/assistant/)).not.toBeInTheDocument()
		expect(screen.getByText("Advanced settings").closest("details")).not.toHaveAttribute("open")
	})
	it("preserves inactive target overrides and restores them on re-enable", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		render(
			<LocalInferenceSettingsForm
				config={config("A", {
					...defaults,
					compaction: { targetTokens: 61000 },
					userOverrides: ["compaction.targetTokens"],
				})}
				selectedModelId="A"
				write={write}
			/>,
		)
		fireEvent.click(screen.getByLabelText("Override compaction target"))
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		const inactive = parse(write.mock.calls[0][0])
		expect(inactive.compaction.targetTokens).toBe(61000)
		expect(inactive.disabledOverrides).toContain("compaction.targetTokens")
		expect(screen.getByLabelText("Compaction target tokens")).toHaveValue(64000)
		await waitFor(() => expect(screen.getByLabelText("Override compaction target")).toBeEnabled())
		fireEvent.click(screen.getByLabelText("Override compaction target"))
		await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
		expect(parse(write.mock.calls[1][0]).disabledOverrides).not.toContain("compaction.targetTokens")
		expect(screen.getByLabelText("Compaction target tokens")).toHaveValue(61000)
	})
	it("keeps normal output and summary allowance independent", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={write} />)
		fireEvent.click(screen.getByLabelText("Override normal output"))
		await waitFor(() => expect(screen.getByLabelText("Normal output tokens (including thinking)")).toBeEnabled())
		const output = screen.getByLabelText("Normal output tokens (including thinking)")
		fireEvent.change(output, { target: { value: "16000" } })
		fireEvent.blur(output)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
		expect(screen.getByLabelText("Summarized history tokens")).toHaveValue(14000)
		expect(screen.getByLabelText("Compaction target tokens")).toHaveValue(64000)
		await waitFor(() => expect(screen.getByLabelText("Override summarized history")).toBeEnabled())
		fireEvent.click(screen.getByLabelText("Override summarized history"))
		await waitFor(() => expect(screen.getByLabelText("Summarized history tokens")).toBeEnabled())
		const summary = screen.getByLabelText("Summarized history tokens")
		fireEvent.change(summary, { target: { value: "10000" } })
		fireEvent.blur(summary)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(4))
		expect(parse(write.mock.calls[3][0])).toMatchObject({ maxOutputTokens: 16000, compaction: { summaryTokens: 10000 } })
		expect(screen.getByRole("region", { name: "Context budget breakdown" })).toHaveTextContent("44,000")
	})
	it("requires a missing server capacity to be entered and never saves invalid budgets", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		render(<LocalInferenceSettingsForm config={config("A", {})} selectedModelId="A" write={write} />)
		expect(screen.getByRole("alert")).toHaveTextContent("Maximum context size is required")
		const context = screen.getByLabelText("Maximum context size (tokens)")
		expect(context).toBeEnabled()
		fireEvent.blur(context)
		expect(write).not.toHaveBeenCalled()
		fireEvent.change(context, { target: { value: "100000" } })
		fireEvent.blur(context)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		expect(parse(write.mock.calls[0][0]).contextWindow).toBe(100000)
	})
	it("restores inactive values across model changes and scopes writes", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		const a = {
			...defaults,
			compaction: { summaryTokens: 12000 },
			userOverrides: ["compaction.summaryTokens"],
			disabledOverrides: ["compaction.summaryTokens"],
		}
		const view = render(<LocalInferenceSettingsForm config={config("A", a)} selectedModelId="A" write={write} />)
		view.rerender(
			<LocalInferenceSettingsForm
				config={config("B", {
					...defaults,
					contextWindow: 200000,
					serverDefaults: { contextWindow: 200000, maxOutputTokens: 8000 },
				})}
				selectedModelId="B"
				write={write}
			/>,
		)
		expect(screen.getByLabelText("Summarized history tokens")).toHaveValue(16000)
		view.rerender(<LocalInferenceSettingsForm config={config("A", a)} selectedModelId="A" write={write} />)
		fireEvent.click(screen.getByLabelText("Override summarized history"))
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		expect(screen.getByLabelText("Summarized history tokens")).toHaveValue(12000)
		expect(write.mock.calls[0][0]).toMatchObject({ localInferenceModelId: "A", localInferenceScope: "fixture-scope" })
	})
	it("disables a mismatched model and reports write failures", async () => {
		const write = vi.fn(async () => {
			throw new Error("Selected model changed")
		})
		const view = render(<LocalInferenceSettingsForm config={config()} selectedModelId="B" write={write} />)
		expect(screen.getByLabelText("Override normal output")).toBeDisabled()
		view.rerender(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={write} />)
		fireEvent.click(screen.getByLabelText("Override normal output"))
		expect(await screen.findByRole("alert")).toHaveTextContent("Selected model changed")
	})
})
