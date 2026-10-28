# Cline / AI Local builds and deployment

Both clients are built from the clean primary `local-main` checkout using the same committed SDK source. Develop and validate changes in temporary feature worktrees as described in [`LOCAL_DEVELOPMENT.md`](../LOCAL_DEVELOPMENT.md).

## Release identity

[`release.json`](release.json) owns the fork version, display name and description. Use `year.month.release`, with no leading zeroes: `2026.10.1`, `2026.10.2`, then `2026.11.1`. Increment for each new release, whether it includes fork fixes, an upstream merge, or both. Both clients receive the same release number. Core's package version remains its upstream SDK version.

Upstream merges do not automatically create a fork release. Integrate, validate, choose the release number, commit, and build both clients. Once the artifacts pass verification, create an annotated tag `fork/<version>` on that source commit. Never move an existing release tag or reuse its version for another source commit. Rebuilds of the same tagged source must still retain their own artifact hashes and build time.

The upstream CLI and extension `package.json` versions remain unchanged in committed source. The release helper temporarily stamps their version, display name and description during the build, and restores their exact original bytes on success, compiler failure or a handled interruption. It preserves package names, executable names, extension publisher and extension identifier so existing settings and sessions remain associated with the same extension.

Do not edit source concurrently with a release build. The helper locks out a second release build in the same checkout. A forced process kill or machine shutdown cannot run cleanup; if that happens, review and restore the two package manifests and extension README before trying again.

## Build both clients

Requirements: Linux, Bun 1.4.2, Node >=22, Python 3 and Git. Inspect the planned identity without building:

```sh
python3 local/release.py check
```

Build from a clean, committed primary `local-main`:

```sh
bash local/build-wsl.sh
```

The helper installs locked dependencies before stamping, builds the SDK once, type-checks both clients, compiles and smoke-tests the native CLI with isolated Hub state, builds the Node CLI and extension, writes provenance, then packages the VSIX. It checks the installed version fields inside the artifacts, preserved extension identity, fork README/banner and shared runtime fingerprint, and records SHA-256 hashes.

Artifacts:

- Native CLI: `apps/cli/dist/cli-linux-<architecture>/`.
- Node CLI: `apps/cli/dist/index.js`, with its copied plugin runtime.
- Extension: `apps/vscode/dist/cline-ai-local-<version>.vsix`.
- Build receipt: `apps/vscode/dist/release-artifacts.json`.

Matching `source-provenance.json` files accompany both clients and are included inside the VSIX. They record the fork version and source/tree identity, the latest common ancestor with upstream `origin/main`, original upstream manifest versions, build time and Core runtime fingerprint. Provenance contains no workstation paths or credentials. Build artifacts and dependencies remain untracked.

After verification, tag the exact built commit, for example:

```sh
git tag -a fork/2026.10.1 -m "Cline / AI Local 2026.10.1"
```

Tags and branches are only published when explicitly pushed. The CLI launcher remains `cline`.

## Verify and deploy

`verify-binary.py` exercises an isolated local mock API. Its optional `--live` mode reads the configured provider and sends real inference; use it only when a live check is intended.

```sh
python3 local/verify-binary.py apps/cli/dist/cli-linux-x64/bin/cline
sudo bash local/deploy-wsl.sh
```

Deployment checks the source commit and matching fork release in provenance, copies the CLI package into `/opt/cline-local/releases/`, selects it atomically through `/opt/cline-local/current`, and installs a launcher with automatic updates disabled. Previous releases are retained. It does not restart active clients or the shared Hub. Activate a new Hub after active work has finished; select the prior release to roll back.

Install the matching VSIX into the intended editor host, keep marketplace updates disabled for this local build, and reload the editor after active work has finished. Model profiles, provider endpoints, notification settings and saved transcripts belong in user state, not source commits.

## Local improvements

The fork retains native local providers and measured counting, per-model settings, bounded compaction and overflow recovery, resumed sessions and stable compacted prefixes, paged web evidence, a native editor, checkpoint/Undo lineage, reasoning previews, verified waits, shutdown logging guards and response-completion notification preferences. Feature branches remain available for review and upstream preparation; equivalent upstream changes can replace local patches as they arrive.
