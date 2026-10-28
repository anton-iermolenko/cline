#!/usr/bin/env python3
"""Build AI Local releases without committing changes to upstream manifests."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import mmap
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
MANIFESTS = {"cli": "apps/cli/package.json", "extension": "apps/vscode/package.json"}


def run(root, *args):
    subprocess.run(args, cwd=root, check=True)


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def read_release(root):
    release = json.loads((root / "local/release.json").read_text())
    if not re.fullmatch(r"[1-9]\d{3}\.(?:[1-9]|1[0-2])\.[1-9]\d*", release["version"]):
        raise ValueError("Fork version must be year.month.release, with no leading zeroes")
    for field in ["displayName", "description"]:
        if not isinstance(release[field], str) or not release[field].strip():
            raise ValueError(f"Missing release {field}")
    return release


def provenance(root):
    release = read_release(root)
    versions = {name: json.loads((root / path).read_text())["version"] for name, path in MANIFESTS.items()}
    versions["core"] = json.loads((root / "sdk/packages/core/package.json").read_text())["version"]
    upstream = git(root, "merge-base", "HEAD", "refs/remotes/origin/main")
    source = git(root, "rev-parse", "HEAD")
    tag = "fork/" + release["version"]
    tagged = subprocess.run(["git", "rev-parse", "--verify", "refs/tags/" + tag + "^{commit}"], cwd=root, capture_output=True, text=True)
    if tagged.returncode == 0 and tagged.stdout.strip() != source:
        raise ValueError(f"{tag} already identifies another commit; increment local/release.json")
    return {
        "forkVersion": release["version"],
        "displayName": release["displayName"],
        "description": release["description"],
        "sourceCommit": source,
        "sourceBranch": git(root, "branch", "--show-current"),
        "sourceTree": git(root, "rev-parse", "HEAD^{tree}"),
        "upstreamCommit": upstream,
        "upstreamVersions": versions,
        "versions": {"cli": release["version"], "extension": release["version"], "core": versions["core"]},
    }


@contextmanager
def stamped_manifests(root, release):
    """Restore exact original bytes even when a compiler or packaging step fails."""
    originals = {root / path: (root / path).read_bytes() for path in MANIFESTS.values()}
    readme = root / "apps/vscode/README.md"
    originals[readme] = readme.read_bytes()
    banner = root / "apps/vscode/assets/branding/ai-local-banner.png"
    if banner.exists():
        raise ValueError("Remove the stale generated extension banner before rebuilding")
    try:
        for path in [root / p for p in MANIFESTS.values()]:
            manifest = json.loads(originals[path])
            for field in ["version", "displayName", "description"]:
                manifest[field] = release[field]
            if release.get("repository"):
                manifest["repository"] = {**manifest.get("repository", {}), "url": release["repository"]}
                manifest["homepage"] = release["repository"]
                manifest["bugs"] = {"url": release["repository"] + "/issues"}
            path.write_text(json.dumps(manifest, indent="\t", ensure_ascii=False) + "\n")
        readme.write_bytes((root / "README.md").read_bytes())
        banner.parent.mkdir(parents=True, exist_ok=True)
        banner.write_bytes((root / "assets/branding/ai-local-banner.png").read_bytes())
        yield
    finally:
        for path, contents in originals.items():
            path.write_bytes(contents)
        banner.unlink(missing_ok=True)


def write_provenance(root, record, package):
    for target in [package / "source-provenance.json", root / "apps/cli/dist/source-provenance.json", root / "apps/vscode/dist/source-provenance.json"]:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(record, indent=2) + "\n")


def verify_artifacts(root, record, package, vsix):
    import zipfile
    expected = record["forkVersion"]
    actual = subprocess.check_output([str(package / "bin/cline"), "--version"], text=True).strip()
    if actual != expected or json.loads((package / "package.json").read_text())["version"] != expected:
        raise ValueError("Compiled CLI version does not match the fork release")
    with zipfile.ZipFile(vsix) as archive:
        manifest = json.loads(archive.read("extension/package.json"))
        if any(manifest[k] != record[k] for k in ["displayName", "description"]):
            raise ValueError("Packaged extension branding does not match the release")
        if manifest["version"] != expected or manifest["name"] != "claude-dev" or manifest["publisher"] != "saoudrizwan":
            raise ValueError("Packaged extension version or preserved identity is incorrect")
        if json.loads(archive.read("extension/dist/source-provenance.json")) != record:
            raise ValueError("VSIX provenance does not match the CLI")
        if archive.read("extension/assets/branding/ai-local-banner.png") != (root / "assets/branding/ai-local-banner.png").read_bytes():
            raise ValueError("VSIX is missing the fork banner")
        if "What this fork provides" not in archive.read(next(name for name in archive.namelist() if name.lower() == "extension/readme.md")).decode():
            raise ValueError("VSIX is missing the fork introduction")
        runtime = record["coreRuntimeBuildId"].encode()
        if runtime not in archive.read("extension/dist/extension.js"):
            raise ValueError("Extension runtime identity does not match provenance")
    node_version = subprocess.check_output(["node", str(root / "apps/cli/dist/index.js"), "--version"], cwd=root, text=True).strip()
    if node_version != expected:
        raise ValueError("Node CLI version does not match the fork release")
    for path in [package / "bin/cline", root / "apps/cli/dist/index.js"]:
        with path.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as content:
            if content.find(runtime) < 0:
                raise ValueError("CLI runtime identity does not match provenance")
    files = [package / "bin/cline", root / "apps/cli/dist/index.js", vsix]
    artifacts = []
    for path in files:
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        artifacts.append({"path": str(path.relative_to(root)), "bytes": path.stat().st_size, "sha256": digest})
    receipt = {**record, "artifacts": artifacts}
    (root / "apps/vscode/dist/release-artifacts.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def build(root):
    record = provenance(root)
    if record["sourceBranch"] != "local-main" or git(root, "status", "--porcelain"):
        raise ValueError("Build releases from a clean, committed local-main checkout")
    if subprocess.check_output(["bun", "--version"], text=True).strip() != "1.4.2":
        raise ValueError("Bun 1.4.2 required")
    arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    if platform.system() != "Linux" or not arch:
        raise ValueError("This release helper targets Linux x64/arm64")
    package = root / "apps/cli/dist" / ("cli-linux-" + arch)
    # Install against upstream manifests before applying transient fork versions.
    run(root, "bun", "install", "--frozen-lockfile")
    with stamped_manifests(root, read_release(root)):
        run(root, "bun", "run", "build:sdk")
        run(root, "bun", "-F", "@cline/cli", "typecheck")
        run(root, "bun", "apps/cli/script/build.ts", "--single", "--skip-install", "--skip-sdk-build")
        # Native compilation clears dist; build the Node bundle afterwards.
        run(root, "bun", "-F", "@cline/cli", "build")
        extension = root / "apps/vscode"
        run(extension, "bun", "run", "check-types")
        run(extension, "bun", "run", "build:production")
        record["coreRuntimeBuildId"] = subprocess.check_output(["bun", "--eval", "import {resolveSdkRuntimeBuildId} from './sdk/packages/core/scripts/runtime-build-id'; console.log(resolveSdkRuntimeBuildId(process.cwd()))"], cwd=root, text=True).strip()
        record["builtAtUtc"] = datetime.now(timezone.utc).isoformat()
        write_provenance(root, record, package)
        # Provenance must exist before packaging so the archive includes it.
        run(root, "node", "local/package-extension.cjs")
        vsix = extension / "dist" / ("cline-ai-local-" + record["forkVersion"] + ".vsix")
        receipt = verify_artifacts(root, record, package, vsix)
    if git(root, "status", "--porcelain"):
        raise ValueError("Build changed tracked source; review before deployment")
    print(json.dumps(receipt, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "build"])
    args = parser.parse_args()
    lock_path = Path(git(ROOT, "rev-parse", "--path-format=absolute", "--git-path", "ai-local-build.lock"))
    with lock_path.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "check":
            print(json.dumps(provenance(ROOT), indent=2))
        else:
            def interrupted(signum, _frame):
                raise KeyboardInterrupt(f"Release interrupted by signal {signum}")
            for signum in [signal.SIGTERM, signal.SIGHUP]:
                signal.signal(signum, interrupted)
            build(ROOT)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError, BlockingIOError) as error:
        sys.exit(str(error))
