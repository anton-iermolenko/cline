export interface EngineTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, boolean>;
}
export interface FileEditorEngine {
	tools: EngineTool[];
	call(
		name: string,
		input: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
	preview(
		name: string,
		input: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
}
export const DEFAULT_MAX_CHARS: number;
export function fileEditorToolDefinitions(
	maxChars?: number,
	advertiseLengthBounds?: boolean,
): EngineTool[];
export function createEditor(options?: {
	maxChars?: number;
	roots?: string[];
	advertiseLengthBounds?: boolean;
	lockTimeoutMs?: number;
}): Promise<FileEditorEngine>;
