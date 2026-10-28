# Documentation and recoverability

## Required behavior

- Remove obsolete instructions and references when functionality is removed.
- Preserve recoverability before overwriting/deleting external or untracked configuration that could contain unrelated content, or when the project requires it.
- Keep frequently injected entry instructions, such as AGENTS.md, stable to preserve prompt-prefix cache reuse. Change them for stable, cross-cutting decisions or an explicit user request; put feature details, transient status, and work in progress in the appropriate feature document.

## Default preferences

- Keep technical and operating documents focused on current requirements, behavior, and unresolved limitations. Update the authoritative document instead of adding overlapping notes.
- Use Git for tracked history. Avoid routine backups of tracked content, resolved-issue narratives, detailed change logs, and restoration chapters unless requested or required.
- Clean up task-created scratch artifacts when their purpose is complete.
