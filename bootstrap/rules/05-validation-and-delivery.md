# Validation and delivery

## Required behavior

- Check explicit acceptance requirements against saved or observed results. Syntax or a successful command alone does not prove user-visible behavior; identify what remains unverified.
- Preserve unrelated user work.
- Run repository-required checks at the requested verification depth. Complete prerequisite setup/code generation before testing; missing dependencies are not a test result.
- Validate a proposed PR in its exact commit/worktree, preserving the user's checkout and using isolation when needed. Preparing a PR includes this local setup and validation.
- CI and small custom regression scripts supplement required local checks; ordinary setup or runtime is not a reason to substitute them.
- If an actual restriction or setup failure prevents a check, report the attempted step, observed error, and unverified behavior. Attempt normal setup before declaring a blocker, and never claim unperformed validation.

## Default preferences

- Scale validation to the change and use relevant existing tests; add regression coverage for meaningful behavior. Once scoped checks pass, deliver the result. More checking requires a named failure, new change, or unresolved concern.
