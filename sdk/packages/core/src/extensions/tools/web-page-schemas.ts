import { z } from "zod";

export const LoadWebPageSchema = z
	.object({ url: z.string().url().max(4096) })
	.strict();
export const SearchWebPageSchema = z
	.object({
		document_id: z.string().regex(/^[a-f0-9]{32}$/),
		query: z.string().trim().min(1).max(256),
		regex: z.boolean().default(false),
		offset: z.number().int().nonnegative().default(0),
	})
	.strict();
export const ReadWebPageSchema = z
	.object({
		document_id: z.string().regex(/^[a-f0-9]{32}$/),
		start_line: z.number().int().positive().default(1),
		line_count: z.number().int().min(1).max(80).default(30),
	})
	.strict();
