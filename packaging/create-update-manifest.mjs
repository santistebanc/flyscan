import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
export const platforms = [
  "windows-x64",
  "windows-arm64",
  "macos-arm64",
  "macos-x64",
  "linux-x64",
  "linux-arm64",
];
export function signature(path) {
  if (!existsSync(path)) throw new Error(`Missing update signature ${path}`);
  const value = readFileSync(path, "utf8").trim();
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Invalid update signature encoding");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(value, "base64"),
  );
  if (
    !decoded.startsWith("untrusted comment:") ||
    !decoded.includes("trusted comment:")
  )
    throw new Error(`Invalid update signature format in ${path}`);
  return value;
}
export function assemble(
  directory,
  version,
  repository,
  notes,
  required = platforms,
) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Use a stable major.minor.patch version");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Expected a GitHub owner/repository");
  const checksums = {},
    updates = {};
  for (const platform of required) {
    const path = join(directory, `build-info-${platform}.json`);
    if (!existsSync(path)) throw new Error(`The ${platform} build is missing`);
    const info = JSON.parse(readFileSync(path, "utf8"));
    if (info.version !== version || info.platform !== platform)
      throw new Error(`The ${platform} build is not version ${version}`);
    for (const [name, digest] of Object.entries(info.files)) {
      if (
        !/^Flyscan-[A-Za-z0-9_.-]+$/.test(name) ||
        Object.hasOwn(checksums, name)
      )
        throw new Error(`Unexpected asset name ${name}`);
      const asset = join(directory, name);
      if (
        !existsSync(asset) ||
        createHash("sha256").update(readFileSync(asset)).digest("hex") !==
          digest
      )
        throw new Error(`${name} does not match its build metadata`);
      checksums[name] = digest;
    }
    for (const [key, name] of Object.entries(info.updates)) {
      if (
        !Object.hasOwn(info.files, name) ||
        !Object.hasOwn(info.files, name + ".sig") ||
        Object.hasOwn(updates, key)
      )
        throw new Error(`Update ${key} does not match the ${platform} build`);
      updates[key] = {
        signature: signature(join(directory, name + ".sig")),
        url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
      };
    }
  }
  return [
    {
      version,
      notes: notes.trim(),
      pub_date: new Date().toISOString(),
      platforms: Object.fromEntries(
        Object.entries(updates).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    checksums,
  ];
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      directory: { type: "string", default: "release" },
      version: { type: "string" },
      repository: { type: "string" },
      notes: { type: "string" },
      platforms: { type: "string", multiple: true },
    },
  });
  if (!values.notes) throw new Error("--notes is required");
  const [manifest, checksums] = assemble(
    values.directory,
    values.version,
    values.repository,
    readFileSync(values.notes, "utf8"),
    values.platforms,
  );
  const write = (name, text) => {
    const path = join(values.directory, name);
    writeFileSync(path + ".tmp", text);
    renameSync(path + ".tmp", path);
  };
  write("latest.json", JSON.stringify(manifest, null, 2) + "\n");
  write(
    "SHA256SUMS.txt",
    Object.entries(checksums)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, digest]) => `${digest}  ${name}\n`)
      .join(""),
  );
  console.log(
    `Release ${manifest.version} ready: ${Object.keys(manifest.platforms).join(", ")}`,
  );
}
