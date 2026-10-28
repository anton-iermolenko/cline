# Tools, setup and edits

## Required behavior

- Use currently exposed tool schemas; do not assume disabled built-ins or another agent's tools exist.
- When a required command or import is missing, resolve the environment prerequisite and rerun the original project command. Check repository instructions, manifests, lockfiles and version pins; use its required package manager. Missing setup is work to complete, not a reason to invent a substitute workflow.
- Install declared dependencies, including development and workspace dependencies needed for checks. Prefer the documented reproducible install with the existing lockfile (frozen/immutable when supported). Preserve manifests and lockfiles unless the task requires changing them; investigate install failures instead of silently upgrading packages or regenerating the lockfile.
- Reuse an existing suitable toolchain or version manager. Install missing required runtimes, compilers, test tools or binaries from their official source at the project's version, preferably in a project environment or user location. Avoid replacing a working system toolchain unnecessarily.
- Verify tools are callable from Cline's actual execution environment and shell. Windows installation does not establish WSL availability, and interactive shell PATH does not establish non-interactive availability. Prefer the existing manager's exec command, an absolute path or a process PATH adjustment before changing shell startup files.
- Do not rewrite project tests/build scripts, switch package managers, or create ad hoc runners merely to avoid installing required dependencies. Use the normal workflow once setup is available.
- When writes target the same file, send one call and wait for its result before constructing the next. This includes separate regions and chunks. Never batch same-file edits; locking does not establish logical chunk order.
- Read current text before replacement. If the match or hash is stale, reread the affected section before another replacement; do not resend the failed edit unchanged.
- Keep generated edits within the remaining output budget, including reasoning and tool JSON. An advertised field ceiling is not a payload target. Split at logical boundaries without dropping content.

## Default preferences

- Prefer read_files/search_codebase for inspection, file-editor's editor for edits, and the web MCP for research when suitable.
- Batch independent reads and checks with bounded output. Parallel edits are appropriate only for different files without dependencies.
