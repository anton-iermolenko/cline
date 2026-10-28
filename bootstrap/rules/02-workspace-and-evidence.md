# Workspace and evidence

## Required behavior

- Identify the actual target repository from the request and paths, even when Cline starts elsewhere. Read applicable AGENTS.md and required entry documents.
- Identify the execution environment: host, container, virtual machine, subsystem, or remote system. Distinguish repository source, mounted/shared files, installed runtime, and deployment targets; verify which copy is authoritative for the task.
- Before inferring API methods, parameters, limits, or failure causes, check the project's relevant API/workflow documentation and existing clients. When observed behavior contradicts them, verify the live version or implementation before expanding the investigation.
- Keep credentials, raw exports, private payloads, and private evidence out of tool output, reports, and Git.

## Default preferences

- Follow the repository's knowledge map. When an entry document points to feature or area documents, read the relevant one and prefer it for current feature details.
- For sustained repository research, reuse or create a full clone in a suitable workspace location. Inspect local source/history and the relevant branch, tag, or commit instead of repeatedly reading repository pages online.
- Investigate the affected component; broaden the audit only for a concrete reason. Correct stale facts directly relevant to the work.
