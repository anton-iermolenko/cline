# Shared local integration

The primary checkout on `local-main` is the source of truth for the CLI, VS Code extension and shared SDK. Individual fixes stay on branches in the same repository. Installed packages and build caches are outputs of this source.

## Develop and integrate

Start from a clean primary checkout and create a temporary worktree:

```sh
git switch local-main
git worktree add -b fix/topic ../cline-topic local-main
cd ../cline-topic/sdk
bun install --frozen-lockfile
```

Build the SDK before tests that consume its exports. Run focused tests and type checks for the changed surfaces, with isolated data and hub discovery for executable smoke tests. Review every staged change and commit message for credentials, personal paths, private hosts and saved transcripts. Run `gitleaks git --pre-commit --staged --redact`. New commits use the repository-local identity documented in `AGENTS.md`.

Once the feature is committed and verified, integrate it from the primary checkout:

```sh
git switch local-main
git merge --no-ff fix/topic
git worktree remove ../cline-topic
```

Retain the feature branch for review and possible upstream submission. Do not force-remove a worktree containing uncommitted or needed ignored files. Preserve that material before cleanup. Avoid committing per-machine release metadata, helper configuration, credentials, binaries or generated dependencies.

## Build the clients from one source

At the clean primary checkout, record `git rev-parse HEAD` with both artifacts. Install locked dependencies, build the SDK once, and build the CLI:

```sh
bun install --frozen-lockfile
bun run build:sdk
bun -F @cline/cli build
bun apps/cli/script/build.ts --single --skip-install --skip-sdk-build
```

Build the extension from the same checkout:

```sh
cd apps/vscode
bun run build:webview
bun esbuild.mjs --production
bunx vsce package --no-dependencies
```

The extension's build script regenerates protocol bindings as needed. Keep source provenance in release artifacts without embedding workstation paths in tracked package metadata. Use the existing host-specific deployment procedure to activate verified packages; keep the previous installed release available for rollback and avoid interrupting active sessions.

## Remotes

`origin` points to the upstream Cline repository. `fork` points to the personal GitHub fork and is the default push destination. Local consolidation does not publish any branch automatically. Review the entire branch diff and its history before publishing, including older retained commits.
