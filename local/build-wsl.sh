#!/bin/bash
set -euo pipefail
source_dir=${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
build_root="${XDG_CACHE_HOME:-$HOME/.cache}/cline-fork-build"
export PATH="$build_root/toolchain:/usr/local/bin:/usr/bin:/bin"
export HUSKY=0
export NODE_OPTIONS=--max-old-space-size=2048
[[ $(bun --version) == 1.4.2 ]] || { echo 'Bun 1.4.2 required' >&2; exit 1; }
mkdir -p "$build_root/source"
rsync -a --exclude=.git --exclude=node_modules --exclude=dist "$source_dir/" "$build_root/source/"
cd "$build_root/source"
bun install --frozen-lockfile
for package in shared llms agents core sdk ui; do
    bun --filter "@cline/$package" build
done
cd apps/cli
bun run typecheck
bun x biome check --skip=lint/a11y/noStaticElementInteractions src/tui/utils/reasoning-preview.ts src/tui/utils/reasoning-preview.test.ts src/tui/hooks/use-agent-events.ts src/tui/components/chat-entry.tsx src/utils/local-model-limits.ts src/utils/local-model-limits.test.ts src/main.ts src/runtime/run-interactive.ts
bun x vitest run --config vitest.config.ts src/utils/local-model-limits.test.ts src/runtime/run-interactive.test.ts src/runtime/interactive/compaction.test.ts src/tui/utils/reasoning-preview.test.ts
bun script/build.ts --single --skip-install --skip-sdk-build
printf 'Built package: %s\n' "$PWD/dist/cli-linux-x64"
