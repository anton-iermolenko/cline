#!/bin/bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo' >&2; exit 1; }
package_dir=${1:?Pass the compiled CLI package directory}
release=${2:-3.0.69-local-$(date -u +%Y%m%dT%H%M%SZ)}
[[ $release =~ ^[a-zA-Z0-9._-]+$ ]] || exit 1
[[ -x "$package_dir/bin/cline" ]] || { echo 'Compiled binary missing' >&2; exit 1; }
base=/opt/cline-local
mkdir -p "$base/releases" "$base/backup"
[[ ! -e "$base/releases/$release" ]] || { echo 'Release already exists' >&2; exit 1; }
cp -a "$package_dir" "$base/releases/$release"
chown -R root:root "$base/releases/$release"
chmod -R go-w "$base/releases/$release"
sha256sum "$base/releases/$release/bin/cline" > "$base/releases/$release/SHA256SUMS"
if [[ ! -e "$base/backup/original-launcher" && ! -L "$base/backup/original-launcher" ]]; then
    # Resolve the original relative npm symlink before storing it elsewhere.
    if [[ -L /usr/local/bin/cline ]]; then
        ln -s "$(readlink -f /usr/local/bin/cline)" "$base/backup/original-launcher"
    elif [[ -e /usr/local/bin/cline ]]; then
        cp -a /usr/local/bin/cline "$base/backup/original-launcher"
    fi
fi
ln -s "releases/$release" "$base/current.new"
mv -Tf "$base/current.new" "$base/current"
cat > /usr/local/bin/cline.local-new <<'WRAPPER'
#!/bin/sh
export CLINE_NO_AUTO_UPDATE=1
exec /opt/cline-local/current/bin/cline "$@"
WRAPPER
chmod 755 /usr/local/bin/cline.local-new
mv -Tf /usr/local/bin/cline.local-new /usr/local/bin/cline
printf 'Installed %s\n' "$release"
/usr/local/bin/cline --version
