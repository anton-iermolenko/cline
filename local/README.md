# Local Cline CLI model-limit patch

Source: `.`, fix-oriented branches under `codex/`.
Upstream: tag `cli-v3.0.69`, commit `ef9430ffb4ceae9a7ab0b95d27cad8133ea7c576`.

The SDK captures the built-in provider catalog before local models.json is loaded. Custom model aliases consequently lose their numeric limits in the runtime even though the model picker displays them. VS Code also intentionally removes provider-wide contextWindow/maxTokens fields when saving an OpenAI-compatible model.

The CLI now overlays the native per-model registry into config.knownModels at startup and after interactive provider/model changes. Local fields win; existing model capabilities are preserved. Input space is clamped to contextWindow minus maxTokens. Updated limits are read from disk each time. That model-registry overlay leaves the VS Code extension unchanged. The additional automatic compaction fix below patches SDK core and is bundled in the CLI.

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

## Reasoning display patch

Streaming thinking now publishes only the latest 2048 characters and eight logical lines, at most once every 100 ms. Chunks are retained separately and joined once when the reasoning block closes; the complete text is restored to the expandable entry and remains in session history. Switching to text/tools, completion, errors, and unmount cancel pending preview timers.

The reasoning renderer uses one stable text node instead of one React element per line keyed by its changing contents. Completed blocks are memoized and their collapsed tail is formatted from a bounded substring. Expanding a completed block still shows the full reasoning. This rendering patch changes only CLI source; the additional compaction patch below also requires rebuilding SDK core.

Additional compiled stress verification:

```sh
python3 ./local/verify-binary.py ~/.cache/cline-fork-build/source/apps/cli/dist/cli-linux-x64/bin/cline --tui --reasoning
```

2026-10-08: 26 focused tests and complete CLI typecheck passed. Changed-file Biome checks passed with the existing DOM accessibility rule excluded for OpenTUI terminal mouse handlers. The compiled TUI handled 5000 streamed reasoning chunks, preserved all 260000 characters exactly, and emitted 28379 terminal-output bytes in this synthetic run. These checks verify the rendering fix; they do not establish the cause of every earlier CPU or memory incident.

## Automatic compaction recovery

Automatic agentic compaction can decline to summarize when there is no older turn to cut, or return no text after reasoning consumes the output budget. Its preservation of an entire latest turn and previously frozen output can also defeat a smaller context window.

The CLI's bundled SDK now retries with basic compaction when the automatic summary is absent, unchanged, or exceeds the target. That emergency fold may re-fold previously preserved output, retains typed user prompts, and uses the existing tool-pair projection. If the final estimate plus request overhead still exceeds the automatic input threshold, it throws a specific error instead of issuing another oversized request. Full saved history remains available. Manual compaction and custom compaction callbacks retain their existing behavior.

Token estimation remains approximate; the guard cannot guarantee an exact match to llama.cpp's tokenizer. Current limits remain 81920 context, 73728 input, 8192 output, with automatic trigger about 66355 and long-conversation target about 36864 before subtracting overhead.

2026-10-08: 100 compaction and budget-projection regression tests passed, including no-summary recovery, oversized latest turns, previously preserved output, tool pairing, and stopping when the protected prompt cannot fit. Deploying this build does not restart an existing CLI session; resume the same session after relaunch to load it.
The compiled `--compaction-guard` check passed: an oversized protected prompt was rejected with zero API requests. CLI typecheck and 26 focused CLI tests passed; the compiled package also passed version, isolated hub lifecycle, and interactive mock checks.

CLI auto backend may reuse a compatible already-running hub, whose SDK is still from the previous executable. Once all Cline tasks are stopped, activate this SDK update with `cline hub stop`, then relaunch/resume Cline. Deployment intentionally does not stop the shared hub or any active task.

```sh
python3 ./local/verify-binary.py ~/.cache/cline-fork-build/source/apps/cli/dist/cli-linux-x64/bin/cline --compaction-guard
```
## October 9 summary-only recovery fix

The basic fallback now supports a working context consisting of a prior agentic summary and tool activity, with no literal user turns. It preserves the summary's system metadata and a bounded recent tool sequence. Automatic basic/agentic compaction and oversized manual compaction enforce bounded results before reporting completion. Errors distinguish a missing fallback result from excessive retained context and label the trigger separately from the input allowance.

Regression coverage: sequential agentic compaction followed by empty, failed, or oversized summarization; oversized manual recovery; summary provenance and tool pairing; truly oversized summaries; missing anchors. The compaction/projection suite passes 107 tests. Offline replay of session example-replay-session reduces 55016 to 33272 estimated message tokens with a 36448-token message target, preserving the original summary metadata. This replay does not edit session state.

The 81920 total context, 73728 request-input allowance, 8192 output cap, and 66355 early-compaction trigger are unchanged.

Deployment verified: `/opt/cline-local/current` selects `3.0.69-local-20261009-compaction-recovery`. SDK and CLI typechecks, 107 compaction/projection tests, 13 CLI tests, compiled model-limit request, compiled oversized-request guard (zero API requests), and isolated hub smoke checks passed. Existing CLI processes must be restarted to load the new bundle; the previous release is retained.
