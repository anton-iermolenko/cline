# Documentation and backups

## Required behavior

- Remove obsolete instructions and references when functionality is removed. Keep credentials, raw exports, and private evidence out of Git.
- Preserve recoverability when overwriting or deleting external/untracked configuration could lose unrelated content, or when the project requires it.
- Treat a repo's entry knowledge file (e.g. AGENTS.md) as a **stable** knowledge base: the user typically re-sends it verbatim in each new message, so **any** change to it invalidates the LLM's prompt cache and costs minutes of pre-fill on large contexts. Edit it only when a cross-cutting, decision-relevant, *stable* fact changed, or when the user explicitly asks. Route volatile, feature-scoped, in-progress, or "current state" facts to the location the working folder defines for them, or to an appropriate one.

## Default preferences

- Keep design, API, and operating documents focused on current requirements, behavior, and material unresolved limitations.
- Use Git for tracked history. Avoid resolved-issue narratives, detailed change logs, observation files, and restoration chapters unless requested or required.
- Update the authoritative document instead of creating overlapping notes. Match the requested location and level of detail.
- Avoid routine backup copies of Git-tracked content. Clean up task-created scratch artifacts when their purpose is complete.
