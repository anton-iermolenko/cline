# Tools, setup and output budgets

## Required behavior

- Use the currently exposed tool schemas; do not assume disabled built-ins or another agent's tools exist.
- During authorized implementation, resolve missing commands/imports and rerun the original project command. Follow repository instructions, manifests, lockfiles, and version pins; use the required package manager and install the declared dependencies, including needed development/workspace dependencies.
- Prefer reproducible frozen/immutable installs. Preserve manifests and lockfiles unless the task requires changing them; investigate install failures instead of silently upgrading packages or regenerating lockfiles.
- Reuse a suitable toolchain or version manager. Install missing required runtimes, compilers, test tools, or binaries from official sources at the project's version, preferably in a project environment or user location. Avoid replacing a working system toolchain unnecessarily.
- Verify tools in Cline's actual execution environment and shell. Installation elsewhere does not establish availability here; interactive PATH does not establish non-interactive availability. Prefer a manager's exec command, an absolute executable path, or a process PATH adjustment before changing shell startup files.
- Do not rewrite project tests/build scripts, switch package managers, or invent ad hoc runners merely to avoid installing prerequisites. Use the normal workflow once setup is available.
- Keep complete generated calls within the available output budget, including reasoning and JSON overhead. A tool field ceiling is not a payload target. Split large work at logical boundaries without dropping content.
