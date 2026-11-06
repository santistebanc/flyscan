import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { assemble } from "../create-update-manifest.mjs";
import { setVersion } from "../set-version.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  hash = (body) => createHash("sha256").update(body).digest("hex");
const signature = Buffer.from(
  "untrusted comment: test\nsignature\ntrusted comment: test\nglobal\n",
).toString("base64");
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "flyscan-release-"));
  function build(platform, names, updates, version = "0.3.2") {
    const files = {};
    for (const name of names) {
      const body = Buffer.from(name);
      writeFileSync(join(directory, name), body);
      files[name] = hash(body);
    }
    for (const name of Object.values(updates)) {
      writeFileSync(join(directory, name + ".sig"), signature);
      files[name + ".sig"] = hash(signature);
    }
    writeFileSync(
      join(directory, `build-info-${platform}.json`),
      JSON.stringify({ version, platform, files, updates }),
    );
  }
  build("windows-x64", ["Flyscan-0.3.2-windows-x64-setup.exe"], {
    "windows-x86_64": "Flyscan-0.3.2-windows-x64-setup.exe",
  });
  build(
    "macos-arm64",
    ["Flyscan-0.3.2-macos-arm64.dmg", "Flyscan-0.3.2-macos-arm64.app.tar.gz"],
    { "darwin-aarch64": "Flyscan-0.3.2-macos-arm64.app.tar.gz" },
  );
  build(
    "linux-x64",
    ["Flyscan-0.3.2-linux-x64.AppImage", "Flyscan-0.3.2-linux-x64.deb"],
    {
      "linux-x86_64": "Flyscan-0.3.2-linux-x64.AppImage",
      "linux-x86_64-deb": "Flyscan-0.3.2-linux-x64.deb",
    },
  );
  return {
    directory,
    build,
    create: (
      version = "0.3.2",
      repository = "owner/downloads",
      required = ["windows-x64", "macos-arm64", "linux-x64"],
    ) => assemble(directory, version, repository, "  What changed  ", required),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("manifest preserves signed assets, exact release URLs and notes", () => {
  const f = fixture();
  try {
    const [manifest, checksums] = f.create();
    assert.deepEqual(
      Object.keys(manifest.platforms).sort(),
      [
        "darwin-aarch64",
        "linux-x86_64",
        "linux-x86_64-deb",
        "windows-x86_64",
      ].sort(),
    );
    assert.equal(
      manifest.platforms["windows-x86_64"].url,
      "https://github.com/owner/downloads/releases/download/v0.3.2/Flyscan-0.3.2-windows-x64-setup.exe",
    );
    assert.equal(manifest.platforms["darwin-aarch64"].signature, signature);
    assert.equal(manifest.notes, "What changed");
    assert.ok(checksums["Flyscan-0.3.2-macos-arm64.dmg"]);
    assert.ok(checksums["Flyscan-0.3.2-windows-x64-setup.exe.sig"]);
  } finally {
    f.close();
  }
});
test("a default release requires both architectures of every OS", () => {
  const f = fixture();
  try {
    for (const [platform, key, name] of [
      ["macos-x64", "darwin-x86_64", "Flyscan-0.3.2-macos-x64.app.tar.gz"],
      [
        "windows-arm64",
        "windows-aarch64",
        "Flyscan-0.3.2-windows-arm64-setup.exe",
      ],
      ["linux-arm64", "linux-aarch64-deb", "Flyscan-0.3.2-linux-arm64.deb"],
    ])
      f.build(platform, [name], { [key]: name });
    assert.ok(
      assemble(f.directory, "0.3.2", "owner/downloads", "")[0].platforms[
        "windows-aarch64"
      ],
    );
    unlinkSync(join(f.directory, "build-info-linux-arm64.json"));
    assert.throws(
      () => assemble(f.directory, "0.3.2", "owner/downloads", ""),
      /missing/,
    );
  } finally {
    f.close();
  }
});
test("missing and wrong-version builds are refused", () => {
  const f = fixture();
  try {
    f.build("macos-x64", ["Flyscan-0.3.1-macos-x64.dmg"], {}, "0.3.1");
    assert.throws(
      () => f.create("0.3.2", "owner/downloads", ["windows-x64", "macos-x64"]),
      /not version/,
    );
    unlinkSync(join(f.directory, "build-info-macos-arm64.json"));
    assert.throws(() => f.create(), /missing/);
  } finally {
    f.close();
  }
});
test("tampered assets and signatures cannot reuse build metadata", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, "Flyscan-0.3.2-linux-x64.deb"), "tampered");
    assert.throws(() => f.create(), /does not match/);
    const path = join(f.directory, "Flyscan-0.3.2-windows-x64-setup.exe.sig");
    writeFileSync(path, "not a signature");
    const info = JSON.parse(
      readFileSync(join(f.directory, "build-info-windows-x64.json"), "utf8"),
    );
    info.files["Flyscan-0.3.2-windows-x64-setup.exe.sig"] =
      hash("not a signature");
    writeFileSync(
      join(f.directory, "build-info-windows-x64.json"),
      JSON.stringify(info),
    );
    assert.throws(() => f.create(), /signature/);
  } finally {
    f.close();
  }
});
test("unstable versions and invalid repository names are rejected", () => {
  const f = fixture();
  try {
    assert.throws(() => f.create("0.3.2-beta"), /stable/);
    assert.throws(
      () => f.create("0.3.2", "owner/downloads?redirect=elsewhere"),
      /repository/,
    );
  } finally {
    f.close();
  }
});
const versionFiles = [
  "package.json",
  "backend/package.json",
  "backend/package-lock.json",
  "backend/src/version.ts",
  "desktop/package.json",
  "desktop/package-lock.json",
  "desktop/src-tauri/tauri.conf.json",
  "desktop/src-tauri/Cargo.toml",
  "desktop/src-tauri/Cargo.lock",
  "pyproject.toml",
  "uv.lock",
];
function versions() {
  const directory = mkdtempSync(join(tmpdir(), "flyscan-versions-"));
  for (const name of versionFiles) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    copyFileSync(join(root, name), join(directory, name));
  }
  return directory;
}
test("all application and lockfile versions move together", () => {
  const directory = versions();
  try {
    setVersion(directory, "9.8.7");
    for (const name of versionFiles.filter((n) => n.endsWith(".json")))
      assert.equal(
        JSON.parse(readFileSync(join(directory, name), "utf8")).version,
        "9.8.7",
      );
    assert.match(
      readFileSync(join(directory, "backend/src/version.ts"), "utf8"),
      /version = "9.8.7"/,
    );
    assert.match(
      readFileSync(join(directory, "uv.lock"), "utf8"),
      /name = "flyscan"\r?\nversion = "9.8.7"/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("an invalid version or missing input changes no version files", () => {
  const directory = versions();
  try {
    const original = readFileSync(join(directory, "package.json"), "utf8");
    assert.throws(() => setVersion(directory, "1.0.0-dev"));
    assert.equal(
      readFileSync(join(directory, "package.json"), "utf8"),
      original,
    );
    unlinkSync(join(directory, "uv.lock"));
    assert.throws(() => setVersion(directory, "9.8.7"));
    assert.equal(
      readFileSync(join(directory, "package.json"), "utf8"),
      original,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
