// All advertised tool schemas are flat objects. Validate the same basic contract
// at execution time as well: non-strict clients must get a useful correction.
export function validateArguments(tool, input) {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw Error(tool.name + " arguments must be an object.");
	const { required = [], properties = {} } = tool.inputSchema;
	const missing = required.filter((key) => !Object.hasOwn(input, key));
	const unknown = Object.keys(input).filter(
		(key) => !Object.hasOwn(properties, key),
	);
	if (missing.length || unknown.length) {
		const error = Error(
			tool.name +
				" requires " +
				(required.join(", ") || "no arguments") +
				"." +
				(missing.length ? " Missing: " + missing.join(", ") + "." : "") +
				(unknown.length ? " Unexpected: " + unknown.join(", ") + "." : "") +
				" Resend one corrected call; no change was made.",
		);
		error.code = "invalid_arguments";
		throw error;
	}
}
