import { ProviderConfigResponse } from "@shared/proto/cline/models"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { LocalInferenceSettingsForm } from "./LocalInferenceSettingsForm"

const summaryLabel = "Compaction: Summarized History Budget"
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
describe("native model controls", () => {
	it("shows directly editable defaults, no override checkboxes and the complete allocation", () => {
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={vi.fn()} />)
		expect(screen.getByLabelText("Maximum context size (tokens)")).toBeEnabled()
		expect(screen.getByLabelText("Normal output tokens (including thinking)")).toHaveValue(8000)
		expect(screen.getByLabelText("Compaction: Target Tokens")).toHaveValue(64000)
		expect(screen.getByLabelText(summaryLabel)).toHaveValue(14000)
		expect(screen.getByLabelText(summaryLabel)).toHaveStyle({ fontStyle: "italic" })
		expect(screen.getByLabelText(summaryLabel)).toBeEnabled()
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Tool calling")).not.toBeInTheDocument()
		expect(screen.getByText("Minimum iteration reserve").nextElementSibling).toHaveTextContent("20,000")
		expect(screen.getByText("Additional iteration space").nextElementSibling).toHaveTextContent("57,871")
		expect(screen.getByText("Total iteration space").nextElementSibling).toHaveTextContent("77,871")
		expect(screen.getByText("Counting margin + boundary").nextElementSibling).toHaveTextContent("129")
		expect(screen.getByText("Hard compaction cap").nextElementSibling).toHaveTextContent("121,871")
		expect(screen.queryByText(/This is a planning allocation/)).not.toBeInTheDocument()
		expect(screen.getByText("Advanced settings").closest("details")).not.toHaveAttribute("open")
	})
	it("does not save unchanged fields when moving focus", () => {
		const write = vi.fn()
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={write} />)
		fireEvent.blur(screen.getByLabelText("Compaction: Target Tokens"))
		fireEvent.blur(screen.getByLabelText(summaryLabel))
		fireEvent.blur(screen.getByLabelText("Reasoning effort"))
		expect(write).not.toHaveBeenCalled()
		expect(screen.getByLabelText("Maximum context size (tokens)")).toBeEnabled()
	})
	it("clears an override to its default without deleting the saved budget and permits a new edit", async () => {
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
		const target = screen.getByLabelText("Compaction: Target Tokens")
		expect(target).toHaveStyle({ fontStyle: "normal" })
		fireEvent.change(target, { target: { value: "" } })
		expect(target).toHaveValue(null)
		fireEvent.blur(target)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		const inactive = parse(write.mock.calls[0][0])
		expect(inactive.compaction.targetTokens).toBe(61000)
		expect(inactive.disabledOverrides).toContain("compaction.targetTokens")
		expect(inactive.userOverrides).not.toContain("compaction.targetTokens")
		expect(target).toHaveValue(64000)
		expect(target).toHaveStyle({ fontStyle: "italic" })
		await waitFor(() => expect(target).toBeEnabled())
		fireEvent.change(target, { target: { value: "50000" } })
		fireEvent.blur(target)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
		expect(parse(write.mock.calls[1][0]).disabledOverrides).not.toContain("compaction.targetTokens")
		expect(target).toHaveValue(50000)
		expect(target).toHaveStyle({ fontStyle: "normal" })
	})
	it("keeps normal output and summary allowance independent", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={write} />)
		const output = screen.getByLabelText("Normal output tokens (including thinking)")
		fireEvent.change(output, { target: { value: "16000" } })
		fireEvent.blur(output)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		expect(screen.getByLabelText(summaryLabel)).toHaveValue(14000)
		expect(screen.getByLabelText("Compaction: Target Tokens")).toHaveValue(64000)
		const summary = screen.getByLabelText(summaryLabel)
		await waitFor(() => expect(summary).toBeEnabled())
		fireEvent.change(summary, { target: { value: "10000" } })
		fireEvent.blur(summary)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
		expect(parse(write.mock.calls[1][0])).toMatchObject({ maxOutputTokens: 16000, compaction: { summaryTokens: 10000 } })
		expect(screen.getByRole("region", { name: "Context budget breakdown" })).toHaveTextContent("44,000")
	})
	it("requires a missing server capacity to be entered and never saves invalid budgets", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		render(<LocalInferenceSettingsForm config={config("A", {})} selectedModelId="A" write={write} />)
		expect(screen.getByRole("alert")).toHaveTextContent("Maximum context size is required")
		const context = screen.getByLabelText("Maximum context size (tokens)")
		fireEvent.blur(context)
		expect(write).not.toHaveBeenCalled()
		fireEvent.change(context, { target: { value: "100000" } })
		fireEvent.blur(context)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		expect(parse(write.mock.calls[0][0]).contextWindow).toBe(100000)
	})
	it("activates new edits to inactive values across model changes and scopes writes", async () => {
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
		expect(screen.getByLabelText(summaryLabel)).toHaveValue(16000)
		view.rerender(<LocalInferenceSettingsForm config={config("A", a)} selectedModelId="A" write={write} />)
		const summary = screen.getByLabelText(summaryLabel)
		expect(summary).toHaveValue(14000)
		fireEvent.change(summary, { target: { value: "13000" } })
		fireEvent.blur(summary)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		expect(parse(write.mock.calls[0][0]).compaction.summaryTokens).toBe(13000)
		expect(parse(write.mock.calls[0][0]).disabledOverrides).not.toContain("compaction.summaryTokens")
		expect(write.mock.calls[0][0]).toMatchObject({ localInferenceModelId: "A", localInferenceScope: "fixture-scope" })
	})
	it("disables a mismatched model and reports write failures", async () => {
		const write = vi.fn(async () => {
			throw new Error("Selected model changed")
		})
		const view = render(<LocalInferenceSettingsForm config={config()} selectedModelId="B" write={write} />)
		expect(screen.getByLabelText("Normal output tokens (including thinking)")).toBeDisabled()
		view.rerender(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={write} />)
		const output = screen.getByLabelText("Normal output tokens (including thinking)")
		fireEvent.change(output, { target: { value: "16000" } })
		fireEvent.blur(output)
		expect(await screen.findByRole("alert")).toHaveTextContent("Selected model changed")
	})
	it("edits and resets counting margin without a checkbox, including an explicit zero", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		render(<LocalInferenceSettingsForm config={config()} selectedModelId="A" write={write} />)
		const margin = screen.getByLabelText("Counting margin (tokens)")
		expect(margin).toBeEnabled()
		expect(margin).toHaveValue(128)
		expect(margin).toHaveStyle({ fontStyle: "italic" })
		fireEvent.change(margin, { target: { value: "0" } })
		fireEvent.blur(margin)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		expect(margin).toHaveStyle({ fontStyle: "normal" })
		expect(parse(write.mock.calls[0][0]).compaction.bufferTokens).toBe(0)
		await waitFor(() => expect(margin).toBeEnabled())
		fireEvent.change(margin, { target: { value: "" } })
		fireEvent.blur(margin)
		await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
		expect(margin).toHaveValue(128)
		expect(margin).toHaveStyle({ fontStyle: "italic" })
	})
	it("hides unsupported reasoning controls without losing their values", async () => {
		const write = vi.fn(async (_patch: unknown) => undefined)
		render(
			<LocalInferenceSettingsForm
				config={config("A", {
					...defaults,
					supportsReasoning: true,
					thinking: true,
					thinkingBudgetTokens: 2000,
					reasoningEffort: "high",
					supportsTools: true,
				})}
				selectedModelId="A"
				write={write}
			/>,
		)
		expect(screen.getByLabelText("Reasoning effort")).toHaveValue("high")
		fireEvent.change(screen.getByLabelText("Reasoning support"), { target: { value: "false" } })
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
		expect(screen.queryByLabelText("Reasoning effort")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Thinking token budget")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument()
		expect(parse(write.mock.calls[0][0])).toMatchObject({
			supportsReasoning: false,
			reasoningEffort: "high",
			thinkingBudgetTokens: 2000,
			supportsTools: true,
		})
		await waitFor(() => expect(screen.getByLabelText("Reasoning support")).toBeEnabled())
		fireEvent.change(screen.getByLabelText("Reasoning support"), { target: { value: "true" } })
		await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
		expect(screen.getByLabelText("Reasoning effort")).toHaveValue("high")
		expect(screen.getByLabelText("Thinking token budget")).toHaveValue(2000)
	})
})
