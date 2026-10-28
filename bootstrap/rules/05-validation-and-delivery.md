# Validation and delivery

## Required behavior

- Before reporting completion, check each explicit requirement against the saved or observed result. Identify every requirement still unverified; a successful command or valid syntax alone does not prove user-visible behavior.
- Preserve unrelated user work. Report exactly what changed and what the checks established, including any remaining blocker.
- Run checks required by the project and respect the user's requested verification depth. Install missing prerequisites and run required code generation or prerequisite builds before testing; a missing dependency is not a test result.
- For a pull request, validate the exact proposed commit or worktree using the project's required checks and tests relevant to the change. Preserve the user's current checkout; use an isolated worktree when needed. A request to prepare a PR includes this local setup and validation.
- CI and a small custom regression script can supplement local checks; they do not replace required local validation merely because dependencies must be installed or checks take ordinary time.
- If a real restriction or setup failure prevents a check, report the exact attempted step, observed error and unverified behavior. Do not mark the check passed or validation complete. Do not treat ordinary missing tools or node_modules as an unresolved blocker without attempting the normal setup.

## Default preferences

- Small configuration changes usually need a focused smoke check. Functional changes need checks of the affected behavior, with live readback or UI verification when available.
- Use relevant existing tests; add a regression test when it protects meaningful behavior. Broaden checks for dependencies, failures, or unresolved risk.
- Once appropriate checks pass, finish. Repeat checks only after a change or new evidence warrants it.
