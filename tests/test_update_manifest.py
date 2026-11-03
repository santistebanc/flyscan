import base64
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "update_manifest", Path(__file__).resolve().parents[1] / "packaging/create-update-manifest.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SIGNATURE = base64.b64encode(
    b"untrusted comment: test\nsignature\ntrusted comment: test\nglobal\n"
).decode()


class UpdateManifest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.build(
            "windows-x64",
            ["Flyscan-0.3.2-windows-x64-setup.exe"],
            {"windows-x86_64": "Flyscan-0.3.2-windows-x64-setup.exe"},
        )
        self.build(
            "macos-arm64",
            ["Flyscan-0.3.2-macos-arm64.dmg", "Flyscan-0.3.2-macos-arm64.app.tar.gz"],
            {"darwin-aarch64": "Flyscan-0.3.2-macos-arm64.app.tar.gz"},
        )
        self.build(
            "linux-x64",
            ["Flyscan-0.3.2-linux-x64.AppImage", "Flyscan-0.3.2-linux-x64.deb"],
            {
                "linux-x86_64": "Flyscan-0.3.2-linux-x64.AppImage",
                "linux-x86_64-deb": "Flyscan-0.3.2-linux-x64.deb",
            },
        )

    def build(self, platform, names, updates, version="0.3.2"):
        files = {}
        for name in names:
            (self.root / name).write_bytes(f"{name} bytes".encode())
            files[name] = hashlib.sha256((self.root / name).read_bytes()).hexdigest()
        for name in updates.values():
            signature = self.root / f"{name}.sig"
            signature.write_text(SIGNATURE)
            files[signature.name] = hashlib.sha256(signature.read_bytes()).hexdigest()
        info = {"version": version, "platform": platform, "files": files, "updates": updates}
        (self.root / f"build-info-{platform}.json").write_text(json.dumps(info))

    def create(
        self,
        version="0.3.2",
        repository="owner/downloads",
        platforms=("windows-x64", "macos-arm64", "linux-x64"),
    ):
        return module.assemble(self.root, version, repository, "  What changed  ", platforms)

    def test_manifest_links_every_platform_to_its_signed_asset_in_the_exact_release(self):
        manifest, checksums = self.create()
        self.assertEqual(
            set(manifest["platforms"]),
            {"windows-x86_64", "darwin-aarch64", "linux-x86_64", "linux-x86_64-deb"},
        )
        self.assertEqual(
            manifest["platforms"]["windows-x86_64"]["url"],
            "https://github.com/owner/downloads/releases/download/v0.3.2/Flyscan-0.3.2-windows-x64-setup.exe",
        )
        self.assertEqual(
            manifest["platforms"]["linux-x86_64-deb"]["url"],
            "https://github.com/owner/downloads/releases/download/v0.3.2/Flyscan-0.3.2-linux-x64.deb",
        )
        self.assertEqual(manifest["platforms"]["darwin-aarch64"]["signature"], SIGNATURE)
        self.assertEqual(manifest["notes"], "What changed")
        self.assertIn("Flyscan-0.3.2-macos-arm64.dmg", checksums)
        self.assertIn("Flyscan-0.3.2-windows-x64-setup.exe.sig", checksums)

    def test_a_default_release_needs_both_architectures_of_every_os(self):
        for platform, key, name in (
            ("macos-x64", "darwin-x86_64", "Flyscan-0.3.2-macos-x64.app.tar.gz"),
            ("windows-arm64", "windows-aarch64", "Flyscan-0.3.2-windows-arm64-setup.exe"),
            ("linux-arm64", "linux-aarch64-deb", "Flyscan-0.3.2-linux-arm64.deb"),
        ):
            self.build(platform, [name], {key: name})
        manifest, _ = module.assemble(self.root, "0.3.2", "owner/downloads", "", module.PLATFORMS)
        self.assertTrue({"windows-aarch64", "linux-aarch64-deb"} <= set(manifest["platforms"]))
        (self.root / "build-info-linux-arm64.json").unlink()
        with self.assertRaises(ValueError):
            module.assemble(self.root, "0.3.2", "owner/downloads", "", module.PLATFORMS)

    def test_a_release_without_every_required_platform_is_refused(self):
        (self.root / "build-info-macos-arm64.json").unlink()
        with self.assertRaises(ValueError):
            self.create()

    def test_a_build_of_another_version_is_refused(self):
        self.build("macos-x64", ["Flyscan-0.3.1-macos-x64.dmg"], {}, version="0.3.1")
        with self.assertRaises(ValueError):
            self.create(platforms=("windows-x64", "macos-x64"))

    def test_changed_asset_cannot_reuse_its_build_metadata(self):
        (self.root / "Flyscan-0.3.2-linux-x64.deb").write_bytes(b"tampered")
        with self.assertRaises(ValueError):
            self.create()

    def test_invalid_signature_repository_and_version_are_rejected(self):
        for version, repository in (
            ("0.3.2-beta", "owner/downloads"),
            ("0.3.2", "owner/downloads?redirect=elsewhere"),
        ):
            with self.assertRaises(ValueError):
                self.create(version, repository)
        signature = self.root / "Flyscan-0.3.2-windows-x64-setup.exe.sig"
        signature.write_text("not a signature")
        info = json.loads((self.root / "build-info-windows-x64.json").read_text())
        info["files"][signature.name] = hashlib.sha256(signature.read_bytes()).hexdigest()
        (self.root / "build-info-windows-x64.json").write_text(json.dumps(info))
        with self.assertRaises(ValueError):
            self.create()
