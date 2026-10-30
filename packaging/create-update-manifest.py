"""Create a public update manifest referring to a versioned, signed installer."""

import argparse
import base64
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def manifest(
    directory: Path, version: str, repository: str, notes: str, edition: str = "public"
) -> dict:
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Use a stable major.minor.patch version")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Expected a GitHub owner/repository")
    if edition not in {"public", "private"}:
        raise ValueError("Unknown release edition")
    prefix = "Flyscan-Private" if edition == "private" else "Flyscan"
    name = f"{prefix}-{version}-windows-x64-setup.exe"
    installer = directory / name
    if not installer.is_file():
        raise ValueError("Installer is missing")
    signature = installer.with_suffix(".exe.sig").read_text(encoding="utf-8").strip()
    decoded = base64.b64decode(signature, validate=True).decode("utf-8")
    if not decoded.startswith("untrusted comment:") or "trusted comment:" not in decoded:
        raise ValueError("Invalid update signature format")
    info = json.loads((directory / "build-info.json").read_text(encoding="utf-8"))
    if (
        info["version"] != version
        or info.get("edition", edition) != edition
        or info["sha256"] != hashlib.sha256(installer.read_bytes()).hexdigest()
    ):
        raise ValueError("Installer does not match build metadata")
    return {
        "version": version,
        "edition": edition,
        "notes": notes.strip(),
        "pub_date": datetime.now(timezone.utc).isoformat(),
        "platforms": {
            "windows-x86_64": {
                "signature": signature,
                "url": f"https://github.com/{repository}/releases/download/v{version}/{name}",
            }
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("release"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--edition", choices=["public", "private"], default="public")
    parser.add_argument("--notes", type=Path, required=True)
    args = parser.parse_args()
    value = manifest(
        args.directory,
        args.version,
        args.repository,
        args.notes.read_text(encoding="utf-8"),
        args.edition,
    )
    temporary = args.directory / "latest.json.tmp"
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.directory / "latest.json")
    print(f"Update manifest ready for {value['version']}")
