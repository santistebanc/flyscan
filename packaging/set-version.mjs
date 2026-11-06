import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export function setVersion(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Use a stable major.minor.patch version");
  const changes = new Map();
  for (const name of [
    "package.json",
    "backend/package.json",
    "backend/package-lock.json",
    "desktop/package.json",
    "desktop/package-lock.json",
    "desktop/src-tauri/tauri.conf.json",
  ]) {
    const value = JSON.parse(readFileSync(join(root, name), "utf8"));
    value.version = version;
    if (value.packages) value.packages[""].version = version;
    changes.set(name, JSON.stringify(value, null, 2) + "\n");
  }
  const replace = (name, pattern, replacement) => {
    const text = readFileSync(join(root, name), "utf8");
    if (!pattern.test(text)) throw new Error(`Missing version in ${name}`);
    changes.set(name, text.replace(pattern, replacement));
  };
  for (const name of ["pyproject.toml", "desktop/src-tauri/Cargo.toml"])
    replace(name, /^version = "[^"]+"/m, `version = "${version}"`);
  replace(
    "desktop/src-tauri/Cargo.lock",
    /(name = "flyscan-desktop"\r?\nversion = )"[^"]+"/,
    `$1"${version}"`,
  );
  replace(
    "uv.lock",
    /(name = "flyscan"\r?\nversion = )"[^"]+"/,
    `$1"${version}"`,
  );
  changes.set(
    "backend/src/version.ts",
    `export const version = "${version}";\n`,
  );
  for (const [name, text] of changes) writeFileSync(join(root, name), text);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  setVersion(
    fileURLToPath(new URL("../", import.meta.url)),
    process.argv[2] || "",
  );
  console.log(`Application versions set to ${process.argv[2]}`);
}
