# Workspace and evidence

## Required behavior

- Identify the actual target repository from the request and paths, even when Cline starts outside that repository. Read applicable AGENTS.md and required entry documents before acting.
- Use absolute paths valid in the environment where each operation runs. Identify whether Cline runs on a host, in a container, virtual machine or subsystem, or on a remote system. Distinguish repository source, mounted or shared files, installed runtime, and deployment targets; verify the authoritative copy for the task.
- Before inferring API methods, parameters, limits, or failure causes, check the relevant project API/workflow section and existing clients. If observed behavior contradicts them, verify the live version or implementation before expanding the investigation.
- Keep credentials and private payloads out of tool output, reports, and Git.

## Default preferences

- Follow the repo's own knowledge map: if its entry document (AGENTS.md or README) points to per-feature or area-specific documents, read the relevant one before acting and prefer it for feature details — the entry document is a stable summary, the feature document is the current detailed source.
- For sustained Git repository research, prefer a full clone in an appropriate workspace location available to the execution environment. Reuse an existing clone, inspect local source and history, and verify the relevant branch/tag/commit instead of repeatedly searching the web and reading repository pages.
- Investigate the affected component; broaden the audit only for a concrete reason. Correct stale facts directly relevant to the work.
