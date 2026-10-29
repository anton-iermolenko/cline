import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { LocalModelCostSettings } from "./LocalModelCostSettings"

describe("native token cost estimates", () => {
	it("shows missing prices as unset rather than free and defaults in italic", () => {
		render(<LocalModelCostSettings modelInfo={{ supportsPromptCache: false, inputPrice: 0.01 }} onSave={vi.fn()} />)
		expect(screen.getByLabelText("Input cost")).toHaveValue(0.01)
		expect(screen.getByLabelText("Input cost")).toHaveStyle({ fontStyle: "italic" })
		expect(screen.getByLabelText("Output cost")).toHaveValue(null)
		expect(screen.getByLabelText("Output cost")).toHaveAttribute("placeholder", "Not set")
		expect(screen.queryByText("Free")).not.toBeInTheDocument()
	})
	it("saves explicit zero and preserves unrelated model metadata and other prices", async () => {
		const onSave = vi.fn(async () => undefined)
		render(
			<LocalModelCostSettings
				modelInfo={{ supportsPromptCache: false, inputPrice: 0.01, outputPrice: 0.2 }}
				onSave={onSave}
				overrides={{ contextWindow: 100000, outputPrice: 0.2 }}
			/>,
		)
		expect(screen.getByLabelText("Output cost")).toHaveStyle({ fontStyle: "normal" })
		fireEvent.change(screen.getByLabelText("Input cost"), { target: { value: "0" } })
		fireEvent.blur(screen.getByLabelText("Input cost"))
		await waitFor(() => expect(onSave).toHaveBeenCalledWith({ contextWindow: 100000, inputPrice: 0, outputPrice: 0.2 }))
	})
	it("clears only the edited price override and accepts fractional rates", async () => {
		const onSave = vi.fn(async () => undefined)
		render(
			<LocalModelCostSettings
				modelInfo={{ inputPrice: 0.01, outputPrice: 0.2, supportsPromptCache: true }}
				onSave={onSave}
				overrides={{ inputPrice: 0.01, outputPrice: 0.2 }}
			/>,
		)
		fireEvent.change(screen.getByLabelText("Input cost"), { target: { value: "" } })
		fireEvent.blur(screen.getByLabelText("Input cost"))
		await waitFor(() => expect(onSave).toHaveBeenCalledWith({ outputPrice: 0.2 }))
		await waitFor(() => expect(screen.getByLabelText("Cache read cost")).toBeEnabled())
		fireEvent.change(screen.getByLabelText("Cache read cost"), { target: { value: "0.0025" } })
		fireEvent.blur(screen.getByLabelText("Cache read cost"))
		await waitFor(() =>
			expect(onSave).toHaveBeenLastCalledWith({ inputPrice: 0.01, outputPrice: 0.2, cacheReadsPrice: 0.0025 }),
		)
	})
	it("ignores unchanged values, rejects negative prices, and exposes save errors", async () => {
		const onSave = vi.fn(async () => {
			throw new Error("fixture failure")
		})
		render(<LocalModelCostSettings modelInfo={{ supportsPromptCache: false, inputPrice: 0.01 }} onSave={onSave} />)
		const input = screen.getByLabelText("Input cost")
		fireEvent.blur(input)
		expect(onSave).not.toHaveBeenCalled()
		fireEvent.change(input, { target: { value: "-1" } })
		fireEvent.blur(input)
		expect(onSave).not.toHaveBeenCalled()
		expect(screen.getByRole("alert")).toHaveTextContent("non-negative")
		fireEvent.change(input, { target: { value: "0.03" } })
		fireEvent.blur(input)
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save"))
		expect(input).toBeEnabled()
	})
})
