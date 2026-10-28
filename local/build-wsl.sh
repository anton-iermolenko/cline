#!/bin/bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
exec python3 "$script_dir/release.py" build "$@"
