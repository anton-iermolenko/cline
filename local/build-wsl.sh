#!/bin/bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_dir=$(git -C "$script_dir/.." rev-parse --show-toplevel)
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
[[ $(git -C "$source_dir" branch --show-current) == local-main ]] || { echo 'Build releases from local-main after integrating tested fixes.' >&2; exit 1; }
[[ -z $(git -C "$source_dir" status --porcelain) ]] || { echo 'Commit or preserve source changes before building a release.' >&2; exit 1; }
[[ $(bun --version) == 1.4.2 ]] || { echo 'Bun 1.4.2 required' >&2; exit 1; }
source_commit=$(git -C "$source_dir" rev-parse HEAD)
cd "$source_dir/sdk"
bun install --frozen-lockfile
bun run build:sdk
cd "$source_dir"
bun -F @cline/cli typecheck
bun -F @cline/cli build
bun apps/cli/script/build.ts --single --skip-install --skip-sdk-build
cd apps/vscode
bun run check-types
bun run build:production
node "$source_dir/local/package-extension.cjs"
cd "$source_dir"
python3 - "$source_commit" <<'PY'
import json, pathlib, platform, sys
root = pathlib.Path.cwd()
arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())
package = root / "apps/cli/dist" / ("cli-linux-" + arch)
record = {"sourceCommit": sys.argv[1], "sourceBranch": "local-main", "cliVersion": json.loads((root / "apps/cli/package.json").read_text())["version"], "extensionVersion": json.loads((root / "apps/vscode/package.json").read_text())["version"]}
for target in [package / "source-provenance.json", root / "apps/vscode/dist/source-provenance.json"]:
    target.write_text(json.dumps(record, indent=2) + "\n")
print("Built both clients from " + sys.argv[1])
print("CLI package: " + str(package))
PY
