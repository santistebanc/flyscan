"""A release bumps every version the app carries, uv.lock included, or none of them."""

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("set_version", ROOT / "packaging/set-version.py")
set_version = importlib.util.module_from_spec(spec)
spec.loader.exec_module(set_version)

FILES = (
    "desktop/package.json",
    "desktop/package-lock.json",
    "desktop/src-tauri/tauri.conf.json",
    "desktop/src-tauri/Cargo.toml",
    "desktop/src-tauri/Cargo.lock",
    "pyproject.toml",
    "uv.lock",
    "flyscan/__init__.py",
)


class SetVersion(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        for name in FILES:
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / name, self.root / name)

    def tearDown(self):
        self.directory.cleanup()

    def test_every_version_moves_together(self):
        set_version.set_version(self.root, "9.8.7")
        text = {name: (self.root / name).read_text(encoding="utf-8") for name in FILES}
        self.assertEqual(json.loads(text["desktop/package.json"])["version"], "9.8.7")
        self.assertEqual(json.loads(text["desktop/src-tauri/tauri.conf.json"])["version"], "9.8.7")
        self.assertIn('name = "flyscan"\nversion = "9.8.7"', text["uv.lock"].replace("\r\n", "\n"))
        self.assertIn('__version__ = "9.8.7"', text["flyscan/__init__.py"])

    def test_an_unstable_version_changes_nothing(self):
        before = (self.root / "uv.lock").read_bytes()
        with self.assertRaises(ValueError):
            set_version.set_version(self.root, "1.0.0-dev")
        self.assertEqual((self.root / "uv.lock").read_bytes(), before)
