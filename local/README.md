# Local Cline CLI model-limit patch

Source: `.`, branch `local/model-limits`.
Upstream: tag `cli-v3.0.69`, commit `ef9430ffb4ceae9a7ab0b95d27cad8133ea7c576`.

The SDK captures the built-in provider catalog before local models.json is loaded. Custom model aliases consequently lose their numeric limits in the runtime even though the model picker displays them. VS Code also intentionally removes provider-wide contextWindow/maxTokens fields when saving an OpenAI-compatible model.

The CLI now overlays the native per-model registry into config.knownModels at startup and after interactive provider/model changes. Local fields win; existing model capabilities are preserved. Input space is clamped to contextWindow minus maxTokens. Updated limits are read from disk each time. SDK source and the VS Code extension are unchanged.

## Provider configuration

Keep model limits, reasoning budgets and provider endpoints in user settings. The runtime overlays that configuration without storing workstation-specific values in source.

## Build

Build on Linux rather than the Windows-mounted tree. The canonical source is mirrored into `~/.cache/cline-fork-build/source`; dependencies and build outputs live there. Bun 1.4.2 is at `~/.cache/cline-fork-build/toolchain/bun`. The script requires that toolchain and Node >=22.

From Ubuntu:

```sh
bash ./local/build-wsl.sh
```

For a memory-constrained WSL instance, run the build in a bounded transient service (and keep memory-intensive Cline sessions stopped):

```sh
sudo systemd-run --unit=cline-local-build --uid="$(id -un)" --wait --pipe --collect \
  --property=MemoryMax=2600M --property=MemorySwapMax=512M --property=CPUQuota=150% \
  /bin/bash ./local/build-wsl.sh
```

Verification of the compiled package:

```sh
python3 ./local/verify-binary.py ~/.cache/cline-fork-build/source/apps/cli/dist/cli-linux-x64/bin/cline
python3 ./local/verify-binary.py ~/.cache/cline-fork-build/source/apps/cli/dist/cli-linux-x64/bin/cline --tui
python3 ./local/verify-binary.py ~/.cache/cline-fork-build/source/apps/cli/dist/cli-linux-x64/bin/cline --live
```

The first two use a synthetic local API and isolated settings; --live uses the configured Ubuntu endpoint with temporary state. The interactive check verifies a saved READY response and output cap. Transcript modelInfo intentionally contains only model id/provider; the headless run_result carries the resolved numeric limits. Focused unit tests exercise the real SDK automatic compaction boundary and existing manual compaction behavior.

## Deployment and updates

```sh
sudo bash ./local/deploy-wsl.sh /path/to/compiled-package
```

Packages are copied to `/opt/cline-local/releases/<release>/`; `/opt/cline-local/current` selects the active release. `/usr/local/bin/cline` exports `CLINE_NO_AUTO_UPDATE=1` and launches `/opt/cline-local/current/bin/cline`. Version output remains upstream `3.0.69`; the current symlink identifies the local build.

These paths are not owned by an apt package, so apt upgrade does not replace this build. Cline's automatic update check is disabled. A deliberate global npm reinstall or manual update may replace the launcher; rerun deploy-wsl.sh to restore it. The original npm installation remains available via `/opt/cline-local/backup/original-launcher`. Future upstream upgrades must be incorporated in the fork, rebuilt, and deployed deliberately.

To select a previous local release, atomically replace the current symlink. To restore the original installation:

```sh
sudo cp -a /opt/cline-local/backup/original-launcher /usr/local/bin/cline.rollback-new
sudo mv -Tf /usr/local/bin/cline.rollback-new /usr/local/bin/cline
hash -r
```

User settings, history, and workspaces are preserved. Deployment changes the next CLI invocation; it does not launch a user session.

## Verified

2026-10-08: CLI typecheck passed; Biome checks passed after import sorting; 22 focused tests passed (local registry + interactive model change + manual compaction). Compiled Linux x64 binary passed version and isolated hub start/status/stop smoke tests. Compiled headless and interactive mock requests sent max_tokens=8192 and reasoning_effort=medium. Live llama-adapter READY request completed with resolved 81920/73728/8192 limits.
