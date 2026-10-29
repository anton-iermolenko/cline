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

## Fork GitHub Actions

Keep `sdk-test`, `ext-vscode-test`, `ext-vscode-test-e2e`, and `desktop-test`
enabled. Their existing `main` triggers also accept `local-main`; PR change
filters and manual test runs remain available. SDK checks include CLI, Hub and
root dependency changes. These workflows build and test without publishing.
Qlty coverage uploads are restricted to the upstream repository because forks
do not have its service token. Test coverage artifacts remain available on GitHub.

The test workflows share the `ci-quiet-period` GitHub environment. Configure its
**Wait timer** in repository **Settings > Environments** to choose the quiet
period in whole minutes; zero removes the delay. GitHub holds each workflow's
initial job before assigning a runner, and downstream build/test jobs wait on
that initial job. Both independent desktop test jobs use the same wait timer.
No deployment record is created. New runs cancel older runs of the same workflow
on the same branch or PR, restarting the wait for the new run. Manual and reusable
test runs also respect this environment. Configure the environment in each fork;
its timer is a repository setting, not stored in Git.

Disable all publishing workflows (including `ext-vscode-ab-package` and any
older `ui-publish` entry) and `ext-jb-test-integration` in the fork's GitHub
Actions settings. Retain the upstream workflow files for future merges; disabling
a workflow is a repository setting, not a source-code deletion. Recheck this
policy when upstream adds or renames a workflow. Accessible issue/PR maintenance
workflows remain enabled independently of CI.

## Native local model settings

vLLM and llama.cpp keep Default, Profile 1 and Profile 2 independently for each
server/model. Configure profiles in VS Code. In CLI `/model`, each native model
row shows `D P1 P2` with the selected profile in brackets. Tab cycles the
highlighted model's profile, Enter applies it and Escape discards the draft.
Use Shift+Tab to select the provider row. Other providers retain Tab for provider
selection. A profile's first use copies that model's Default settings; a model
needs a known maximum context size before a profile can be activated.

Token cost estimates are editable in native provider settings, in USD per million
tokens. Prices belong to the provider/model and apply across its three profiles.
Explicit prices use normal text; inherited values use grey italics. A missing
price is unset; an explicit zero is a zero-cost estimate. Clearing a field removes
only that price override, preserving the other model metadata. These estimates
use the shared model registry for both clients.

The focused terminal keyboard test runs without starting a CLI session or Hub:

```sh
cd apps/cli
bun test src/tests/model-selector-profiles.test.tsx
```

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
