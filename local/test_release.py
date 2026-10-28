"""Release failures must never leave fork versions in upstream source files."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_failed_build_restores_manifests_readme_and_generated_banner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            originals = {}
            for name, path in release.MANIFESTS.items():
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                originals[target] = ('{ "name": "' + name + '", "version": "4.1.26", "publisher": "preserved" }\n').encode()
                target.write_bytes(originals[target])
            readme = root / "apps/vscode/README.md"
            originals[readme] = b"original extension readme\n"
            readme.write_bytes(originals[readme])
            (root / "apps/vscode/assets").mkdir()
            (root / "assets/branding").mkdir(parents=True)
            (root / "assets/branding/ai-local-banner.png").write_text("<svg/>")
            (root / "README.md").write_text("What this fork provides\nassets/branding/ai-local-banner.png\n")
            metadata = {"version": "2026.10.1", "displayName": "Cline / AI Local", "description": "Local models"}
            with self.assertRaisesRegex(RuntimeError, "compiler failed"):
                with release.stamped_manifests(root, metadata):
                    extension = json.loads((root / release.MANIFESTS["extension"]).read_text())
                    self.assertEqual(extension["version"], "2026.10.1")
                    self.assertEqual(extension["publisher"], "preserved")
                    self.assertIn("assets/branding/ai-local-banner.png", readme.read_text())
                    raise RuntimeError("compiler failed")
            for path, expected in originals.items():
                self.assertEqual(path.read_bytes(), expected)
            self.assertFalse((root / "apps/vscode/assets/branding/ai-local-banner.png").exists())

    def test_version_rejects_invalid_month_leading_zero_and_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "local").mkdir()
            for version in ["2026.13.1", "2026.01.1", "2026.10.0", "2026.10.1-ai-local"]:
                (root / "local/release.json").write_text(json.dumps({"version": version}))
                with self.assertRaises(ValueError):
                    release.read_release(root)


if __name__ == "__main__":
    unittest.main()
