import { OpenRouterModelInfo } from "@shared/proto/cline/models"
import { describe, expect, it } from "vitest"
import { fromProtobufModelInfo, toProtobufModelInfo } from "./typeConversion"

describe("input allowance model-info round trip", () => {
	it("keeps the input cap separate from total context across the wire", () => {
		const original = { contextWindow: 153600, maxInputTokens: 146599, maxTokens: 7000, supportsPromptCache: false }
		const decoded = OpenRouterModelInfo.decode(OpenRouterModelInfo.encode(toProtobufModelInfo(original)).finish())
		expect(fromProtobufModelInfo(decoded)).toMatchObject(original)
	})
})
