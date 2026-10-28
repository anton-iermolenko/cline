# Cline bootstrap kit

Portable, opt-in setup material for this fork's CLI and VS Code extension.
Checking out or building Cline does not install or activate anything here.

- [`rules/`](rules/): the six global rule files in use when this kit was created.
  Personal paths and execution-environment assumptions were generalized for
  use on hosts, in containers, virtual machines or subsystems, and on remote
  systems. Other wording and policy are preserved. Built-in prompt overlaps
  and conflicts are deliberately left for
  the later harmonization pass. These are instructions, not provider settings.
- [`consult-expert/`](consult-expert/): the working stdio MCP implementation,
  regression tests, installation instructions and configuration templates.
  No credentials, task records, local installation scripts or private reports
  are included. Authentication and runtime state live outside this repository.
- [`notifications/`](notifications/): CLI completion/error hook and a Home
  Assistant webhook automation example. No YOLO support; YOLO skips CLI hooks.

## Install the rule snapshot

Review existing global rules first. Copy the desired files from `bootstrap/rules/`
to `~/.cline/rules/` in the environment where Cline runs. Both clients use the
global rule loader; Windows and WSL have separate homes unless configured to
share them. Preserve unrelated rules and resolve same-name files deliberately.
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
