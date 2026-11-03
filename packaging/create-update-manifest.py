"""Check every platform's build and write the release's update manifest and checksums.

Each desktop build leaves ``build-info-<platform>.json`` beside its assets: the
files it made with their SHA-256, and which of them installed apps update from,
keyed the way the Tauri updater looks them up (``windows-x86_64``,
``windows-aarch64``, ``darwin-aarch64``, ``linux-aarch64-deb``...). A release goes out only when every
required platform is present, every file still has the bytes its build recorded,
and every update has a well-formed signature beside it.
"""

import argparse
import base64
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

#: Every desktop build a release must contain.
PLATFORMS = (
    "windows-x64",
    "windows-arm64",
    "macos-arm64",
    "macos-x64",
    "linux-x64",
    "linux-arm64",
)


def _signature(path: Path) -> str:
    if not path.is_file():
        raise ValueError(f"Missing update signature {path.name}")
    signature = path.read_text(encoding="utf-8").strip()
    decoded = base64.b64decode(signature, validate=True).decode("utf-8")
    if not decoded.startswith("untrusted comment:") or "trusted comment:" not in decoded:
        raise ValueError(f"Invalid update signature format in {path.name}")
    return signature


def assemble(
    directory: Path, version: str, repository: str, notes: str, platforms=PLATFORMS
) -> tuple[dict, dict]:
    """Return the update manifest and ``{file: sha256}`` of every asset to publish."""
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Use a stable major.minor.patch version")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Expected a GitHub owner/repository")
    checksums, updates = {}, {}
    for platform in platforms:
        path = directory / f"build-info-{platform}.json"
        if not path.is_file():
            raise ValueError(f"The {platform} build is missing")
        info = json.loads(path.read_text(encoding="utf-8"))
        if info["version"] != version or info["platform"] != platform:
            raise ValueError(f"The {platform} build is not version {version}")
        for name, digest in info["files"].items():
            if not re.fullmatch(r"Flyscan-[A-Za-z0-9_.-]+", name) or name in checksums:
                raise ValueError(f"Unexpected asset name {name}")
            asset = directory / name
            if not asset.is_file() or hashlib.sha256(asset.read_bytes()).hexdigest() != digest:
                raise ValueError(f"{name} does not match its build metadata")
            checksums[name] = digest
        for key, name in info["updates"].items():
            if name not in info["files"] or f"{name}.sig" not in info["files"] or key in updates:
                raise ValueError(f"Update {key} does not match the {platform} build")
            updates[key] = {
                "signature": _signature(directory / f"{name}.sig"),
                "url": f"https://github.com/{repository}/releases/download/v{version}/{name}",
            }
    manifest = {
        "version": version,
        "notes": notes.strip(),
        "pub_date": datetime.now(timezone.utc).isoformat(),
        "platforms": dict(sorted(updates.items())),
    }
    return manifest, checksums


def _write(path: Path, text: str) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8", newline="\n")
    temporary.replace(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("release"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--notes", type=Path, required=True)
    parser.add_argument("--platforms", nargs="+", default=PLATFORMS)
    args = parser.parse_args()
    value, checksums = assemble(
        args.directory,
        args.version,
        args.repository,
        args.notes.read_text(encoding="utf-8"),
        args.platforms,
    )
    _write(args.directory / "latest.json", json.dumps(value, indent=2) + "\n")
    _write(
        args.directory / "SHA256SUMS.txt",
        "".join(f"{digest}  {name}\n" for name, digest in sorted(checksums.items())),
    )
    print(f"Release {value['version']} ready: {', '.join(value['platforms'])}")
