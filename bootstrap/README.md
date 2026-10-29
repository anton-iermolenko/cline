# Cline bootstrap kit

Portable, opt-in setup material for this fork's CLI and VS Code extension.
Checking out or building Cline does not install or activate anything here.

- [`rules/`](rules/README.md): six global supplements paired with Cline's
  non-YOLO defaults. The rules README maps default coverage to its source files
  and explains which local policies remain. Environment guidance is portable
  across hosts, containers, virtual machines, subsystems and remote systems.
- [`consult-expert/`](consult-expert/): the working stdio MCP implementation,
  regression tests, installation instructions and configuration templates.
  No credentials, task records, local installation scripts or private reports
  are included. Authentication and runtime state live outside this repository.
- [`notifications/`](notifications/): CLI completion/error and waiting-for-answer hooks, plus a Home
  Assistant webhook automation example. No YOLO support; YOLO skips CLI hooks.

## Install the rule supplements

Review existing global rules and [default coverage](rules/README.md) first.
Copy only the desired numbered `0[1-6]-*.md` files to `~/.cline/rules/` in Cline's
execution environment; do not install the rules README as instructions. Use a
client build containing the matching Act-prompt changes. Both clients use the
global rule loader, but separate hosts/containers/subsystems may have separate
homes. Preserve unrelated rules and resolve same-name files deliberately.
Avoid installing duplicate copies in the other global rule directories or in
`~/.agents/AGENTS.md`. Reload/restart the client after changing configuration.

Follow each component's README for its independent, optional setup. Put real
configuration and secrets outside the checkout; the example files contain
placeholders only. This kit does not include a user's model/provider settings.

## Verify without live services

From the repository root, with the expert package installed in a test venv:

```sh
python -m unittest discover -s bootstrap/consult-expert/tests -v
python -m unittest discover -s bootstrap/notifications/tests -v
```

The expert suite uses a fake Codex subprocess and temporary credentials/state;
the notifier suite uses a loopback HTTP fixture. Neither calls a model or a
Home Assistant server. No Cline client rebuild is needed for this opt-in kit.
