import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("update_manifest", Path(__file__).resolve().parents[1] / "packaging/create-update-manifest.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UpdateManifest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.installer = self.root / "Flight-Scraper-0.3.2-windows-x64-setup.exe"
        self.installer.write_bytes(b"test installer")
        self.signature = base64.b64encode(b"untrusted comment: test\nsignature\ntrusted comment: test\nglobal\n").decode()
        self.installer.with_suffix(".exe.sig").write_text(self.signature)
        (self.root / "build-info.json").write_text(json.dumps({"version": "0.3.2", "sha256": hashlib.sha256(self.installer.read_bytes()).hexdigest()}))

    def create(self, version="0.3.2", repository="owner/downloads"):
        return module.manifest(self.root, version, repository, "  What changed  ")

    def test_manifest_links_signature_and_installer_to_the_exact_release(self):
        result = self.create()
        self.assertEqual(result["platforms"]["windows-x86_64"]["url"], "https://github.com/owner/downloads/releases/download/v0.3.2/Flight-Scraper-0.3.2-windows-x64-setup.exe")
        self.assertEqual(result["platforms"]["windows-x86_64"]["signature"], self.signature)
        self.assertEqual(result["notes"], "What changed")

    def test_changed_installer_cannot_reuse_the_manifest_metadata(self):
        self.installer.write_bytes(b"tampered")
        with self.assertRaises(ValueError):
            self.create()

    def test_invalid_signature_repository_and_version_are_rejected(self):
        for version, repository in (("0.3.2-beta", "owner/downloads"), ("0.3.2", "owner/downloads?redirect=elsewhere")):
            with self.assertRaises(ValueError):
                self.create(version, repository)
        self.installer.with_suffix(".exe.sig").write_text("not a signature")
        with self.assertRaises(ValueError):
            self.create()
