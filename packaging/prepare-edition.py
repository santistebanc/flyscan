"""Bake a release edition into the Python service and Tauri configuration."""

import argparse
import json
from pathlib import Path
from urllib.parse import urlparse


def prepare(root, edition, update_origin=""):
    if edition not in {"public", "private"}:
        raise ValueError("Choose public or private")
    config = json.loads((root / "desktop/src-tauri/tauri.conf.json").read_text())
    if edition == "private":
        parsed = urlparse(update_origin)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise ValueError("Private updates require an HTTPS origin without a path")
        config["productName"] = "Flyscan Private"
        config["identifier"] = "com.flyscan.private"
        config["app"]["windows"][0]["title"] = "Flyscan Private"
        config["bundle"]["windows"]["nsis"]["startMenuFolder"] = "Flyscan Private"
        config["plugins"]["updater"]["endpoints"] = [
            update_origin.rstrip("/") + "/updates/private/latest.json"
        ]
    (root / "flyscan/_build.py").write_text(f'EDITION = "{edition}"\n', encoding="utf-8")
    destination = root / "packaging/build/edition.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edition", choices=["public", "private"], required=True)
    parser.add_argument("--update-origin", default="")
    args = parser.parse_args()
    print(prepare(Path(__file__).resolve().parent.parent, args.edition, args.update_origin))
