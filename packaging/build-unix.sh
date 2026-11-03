#!/usr/bin/env bash
# Build, test and package the desktop app on macOS or Linux, for the machine's own
# architecture: PyInstaller does not cross-compile. The Windows build is build-windows.ps1.
#
#   packaging/build-unix.sh [--python python3.12] [--skip-tests] [--updater-release]
#
# macOS: Flyscan-<v>-macos-<arch>.dmg, plus .app.tar.gz for the updater.
# Linux: Flyscan-<v>-linux-<arch>.AppImage, .deb and .rpm, each its own update.
set -euo pipefail

python="python3.12"
skip_tests=false
updater_release=false
while [ $# -gt 0 ]; do
    case "$1" in
        --python) python="$2"; shift 2 ;;
        --skip-tests) skip_tests=true; shift ;;
        --updater-release) updater_release=true; shift ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
fail() { echo "error: $*" >&2; exit 1; }

for tool in uv npm cargo rustup; do
    command -v "$tool" >/dev/null || fail "Missing build tool: $tool"
done
case "$(uname -m)" in
    arm64 | aarch64) arch=arm64; rust_arch=aarch64 ;;
    x86_64) arch=x64; rust_arch=x86_64 ;;
    *) fail "Unsupported architecture: $(uname -m)" ;;
esac
case "$(uname -s)" in
    Darwin) os=macos; target="$rust_arch-apple-darwin"; bundles=app,dmg ;;
    Linux) os=linux; target="$rust_arch-unknown-linux-gnu"; bundles=appimage,deb,rpm ;;
    *) fail "Build on macOS or Linux; Windows uses build-windows.ps1." ;;
esac
platform="$os-$arch"

found="$("$python" -c 'import platform, sys; print(platform.machine().lower(), "%d.%d" % sys.version_info[:2])')"
case "$found" in
    "arm64 3.12" | "aarch64 3.12") [ "$arch" = arm64 ] || fail "Use a native $arch Python 3.12, not $found." ;;
    "x86_64 3.12" | "amd64 3.12") [ "$arch" = x64 ] || fail "Use a native $arch Python 3.12, not $found." ;;
    *) fail "Use a native $arch Python 3.12, not $found." ;;
esac
version="$("$python" -c 'import json; print(json.load(open("desktop/package.json"))["version"])')"
tauri_version="$("$python" -c 'import json; print(json.load(open("desktop/src-tauri/tauri.conf.json"))["version"])')"
[ "$version" = "$tauri_version" ] || fail "Frontend and Tauri versions disagree."
if $updater_release && [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    fail "An updater release requires TAURI_SIGNING_PRIVATE_KEY."
fi

venv="packaging/.venv-$platform"
build_python="$root/$venv/bin/python"
uv venv --allow-existing --python "$python" "$venv"
uv pip sync --python "$build_python" "packaging/requirements-$os.lock"
npm ci --prefix desktop
if ! $skip_tests; then
    "$build_python" -m unittest discover -s tests -q
    npm test --prefix desktop
fi
npm audit --prefix desktop --audit-level=high
npm run build --prefix desktop

sidecar="$root/packaging/dist/$platform/flyscan-sidecar"
stamp="$(mktemp)"
trap 'rm -f "$stamp"' EXIT
sleep 1  # file times can be coarse; the sidecar must be newer than the stamp
"$build_python" -m PyInstaller --noconfirm --clean --distpath "packaging/dist/$platform" \
    --workpath "packaging/build/$platform" packaging/flyscan-sidecar.spec
[ "$sidecar" -nt "$stamp" ] || fail "The sidecar was not rebuilt; refusing to package a stale binary."
"$build_python" packaging/smoke_sidecar.py "$sidecar"
mkdir -p desktop/src-tauri/binaries
cp "$sidecar" "desktop/src-tauri/binaries/flyscan-sidecar-$target"

rustup target add "$target"
if ! $skip_tests; then
    cargo test --manifest-path desktop/src-tauri/Cargo.toml --release --target "$target" --locked --bin flyscan-desktop
fi

# Developer ID signing and notarization happen when Tauri finds APPLE_SIGNING_IDENTITY
# (and APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID); otherwise the app is signed ad hoc,
# which Apple Silicon requires, without the hardened runtime that only notarization needs.
signing=unsigned
macos_overrides=""
if [ "$os" = macos ]; then
    if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
        signing=developer-id
    else
        signing=ad-hoc
        macos_overrides=', "macOS": { "signingIdentity": "-", "hardenedRuntime": false }'
    fi
fi
overrides="$root/packaging/build/bundle-overrides-$platform.json"
mkdir -p "$(dirname "$overrides")"
printf '{ "bundle": { "createUpdaterArtifacts": %s%s } }\n' "$updater_release" "$macos_overrides" > "$overrides"
[ "$os" = linux ] && export APPIMAGE_EXTRACT_AND_RUN=1  # linuxdeploy without FUSE
npm run tauri --prefix desktop -- build --target "$target" --bundles "$bundles" --ci \
    --config "$overrides" -- --locked

bundle="desktop/src-tauri/target/$target/release/bundle"
release="$root/release"
mkdir -p "$release"
only() {  # exactly one bundler output matching the pattern
    local matches=("$@")
    [ ${#matches[@]} -eq 1 ] && [ -f "${matches[0]}" ] || fail "Expected one bundle at $1"
    echo "${matches[0]}"
}
stem="Flyscan-$version-$platform"
# Arrays stay non-empty: macOS ships bash 3.2, where an empty one trips `set -u`.
if [ "$os" = macos ]; then
    cp "$(only "$bundle"/dmg/Flyscan_"$version"_*.dmg)" "$release/$stem.dmg"
    files=("$stem.dmg")
    updates=("--")  # updater key=file
    if $updater_release; then
        cp "$(only "$bundle"/macos/Flyscan.app.tar.gz)" "$release/$stem.app.tar.gz"
        files+=("$stem.app.tar.gz")
        updates+=("darwin-$rust_arch=$stem.app.tar.gz")
    fi
else
    cp "$(only "$bundle"/appimage/Flyscan_"$version"_*.AppImage)" "$release/$stem.AppImage"
    cp "$(only "$bundle"/deb/Flyscan_"$version"_*.deb)" "$release/$stem.deb"
    cp "$(only "$bundle"/rpm/Flyscan-"$version"-*.rpm)" "$release/$stem.rpm"
    files=("$stem.AppImage" "$stem.deb" "$stem.rpm")
    updates=("--")
    # Each package updates as its own kind: the updater looks for linux-<arch>-<installer>
    # first, and an app that cannot tell falls back to the AppImage.
    if $updater_release; then
        updates+=("linux-$rust_arch=$stem.AppImage" "linux-$rust_arch-appimage=$stem.AppImage"
            "linux-$rust_arch-deb=$stem.deb" "linux-$rust_arch-rpm=$stem.rpm")
    fi
fi
if $updater_release; then
    for name in "${files[@]}"; do
        [ "${name%.dmg}" = "$name" ] || continue  # the disk image only installs
        file="$release/$name"
        rm -f "$file.sig"
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
            npm run tauri --prefix desktop -- signer sign "$file" >/dev/null
        [ -f "$file.sig" ] || fail "The updater signature for $name was not produced."
        cargo run --manifest-path desktop/src-tauri/Cargo.toml --example verify-artifact --release \
            --target "$target" --locked -- desktop/src-tauri/tauri.conf.json "$file" "$file.sig"
        files+=("$name.sig")
    done
fi
"$build_python" - "$release" "$platform" "$version" "$signing" "${files[@]}" "${updates[@]}" <<'EOF'
import hashlib, json, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

release, platform, version, signing, *rest = sys.argv[1:]
split = rest.index("--")
files, updates = rest[:split], rest[split + 1 :]
info = {
    "version": version,
    "platform": platform,
    "files": {name: hashlib.sha256((Path(release) / name).read_bytes()).hexdigest() for name in files},
    "updates": dict(update.split("=", 1) for update in updates),
    "signature": signing,
    "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
    "uncommittedChanges": bool(subprocess.check_output(["git", "status", "--porcelain"])),
    "builtAtUtc": datetime.now(timezone.utc).isoformat(),
}
(Path(release) / f"build-info-{platform}.json").write_text(json.dumps(info, indent=2) + "\n")
EOF
echo "Desktop app ready in $release ($platform, signing: $signing)"
