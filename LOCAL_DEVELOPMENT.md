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

At the clean primary checkout, use the shared fork release helper:

```sh
python3 local/release.py check
bash local/build-wsl.sh
```

`local/release.json` owns the shared CLI/extension fork version and branding.
Upstream package versions remain unchanged in committed source; the helper stamps
both clients during the build and restores the original manifests afterwards.
It records source/upstream commits, original upstream versions, runtime identity
and artifact hashes, and includes the fork introduction in the VSIX. See
[`local/README.md`](local/README.md) for release numbering, tagging and deployment.

Do not edit source concurrently with a release build. Build and verify before
tagging `fork/<version>`. Keep runtime configuration and per-machine state outside
source commits. Deploy verified packages without interrupting active sessions,
and retain the prior installed release for rollback.

## Remotes

`origin` points to the upstream Cline repository. `fork` points to the personal GitHub fork and is the default push destination. Local consolidation does not publish any branch automatically. Review the entire branch diff and its history before publishing, including older retained commits.
