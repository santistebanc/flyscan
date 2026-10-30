"""Keep the desktop, service and lockfile versions in step before tagging a release."""

import argparse
import json
import re
from pathlib import Path


def set_version(root: Path, version: str) -> None:
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Use a stable major.minor.patch version")
    changes = {}
    for name in (
        "desktop/package.json",
        "desktop/package-lock.json",
        "desktop/src-tauri/tauri.conf.json",
    ):
        path = root / name
        value = json.loads(path.read_text(encoding="utf-8"))
        value["version"] = version
        if "packages" in value:
            value["packages"][""]["version"] = version
        changes[path] = json.dumps(value, indent=2) + "\n"
    for name in ("pyproject.toml", "desktop/src-tauri/Cargo.toml"):
        path = root / name
        changes[path], count = re.subn(
            r'^version = "[^"]+"',
            f'version = "{version}"',
            path.read_text(encoding="utf-8"),
            count=1,
            flags=re.M,
        )
        if count != 1:
            raise ValueError(f"Missing version in {name}")
    path = root / "desktop/src-tauri/Cargo.lock"
    changes[path], count = re.subn(
        r'(name = "flyscan-desktop"\nversion = )"[^"]+"',
        rf'\g<1>"{version}"',
        path.read_text(encoding="utf-8"),
        count=1,
    )
    if count != 1:
        raise ValueError("Missing desktop version in Cargo.lock")
    path = root / "uv.lock"
    changes[path], count = re.subn(
        r'(name = "flyscan"\r?\nversion = )"[^"]+"',
        rf'\g<1>"{version}"',
        path.read_text(encoding="utf-8"),
        count=1,
    )
    if count != 1:
        raise ValueError("Missing service version in uv.lock")
    path = root / "flyscan/__init__.py"
    changes[path], count = re.subn(
        r'__version__ = "[^"]+"',
        f'__version__ = "{version}"',
        path.read_text(encoding="utf-8"),
        count=1,
    )
    if count != 1:
        raise ValueError("Missing service version")
    for path, text in changes.items():
        path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    args = parser.parse_args()
    set_version(Path(__file__).resolve().parent.parent, args.version)
    print(f"Application versions set to {args.version}")
