# Local builds and deployment

Both the CLI and VS Code extension are built from the clean primary checkout on `local-main`, using the same committed SDK source. Development and validation happen in temporary feature worktrees, described in [`LOCAL_DEVELOPMENT.md`](../LOCAL_DEVELOPMENT.md).

## Build both clients

Requirements: Linux, Bun 1.4.2, Node >=22, Python 3, and Git. From the primary checkout:

```sh
bash local/build-wsl.sh
```

The helper requires a clean `local-main`, installs locked dependencies, builds the SDK, checks both clients, builds and smoke-tests the native CLI, and bundles and packages the extension. Source is built in place; no cache directory becomes a separate source checkout. Generated packages include or have an adjacent `source-provenance.json` identifying the integration commit without recording workstation paths.

The CLI package is under `apps/cli/dist/cli-linux-<architecture>/`. The extension VSIX is under `apps/vscode/dist/`. Dependencies, native binaries, VSIX files and per-machine configuration remain untracked build artifacts.

## Verify and deploy

`verify-binary.py` exercises an isolated local mock API. It also supports interactive, reasoning-stream and compaction-guard checks. Its optional `--live` mode reads the current user's configured provider and sends real inference; use it only when a live check is intended.

```sh
python3 local/verify-binary.py apps/cli/dist/cli-linux-x64/bin/cline
```

After validation, deploy the CLI from the same primary checkout:

```sh
sudo bash local/deploy-wsl.sh
```

The deployment helper verifies source provenance, copies the package into `/opt/cline-local/releases/`, selects it atomically through `/opt/cline-local/current`, and installs the launcher with automatic updates disabled. It retains previous releases and does not restart active clients or their shared hub. Activate a new hub only when active work has finished. To roll back, select the previous retained release.

Install the matching VSIX into the intended editor host using that host's extension installation command, then reload the editor after active work has finished. Runtime settings, model aliases, provider endpoints, notification configuration and saved transcripts belong in user state, not source commits.

## Local fixes retained by integration

Integration retains per-model input limits and measured request counting, bounded automatic compaction and context recovery, checkpoint/Undo lineage, stable compacted prefixes, recovery after a missing hub session, reasoning previews, paged evidence reads, blocking expert waits, closed-output logging guards, internal token-notice filtering, and the response-completion notification preference. Individual feature branches remain available for review and upstream preparation.
