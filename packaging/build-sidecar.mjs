import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  chmodSync,
  statSync,
  utimesSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: { python: { type: "string" }, platform: { type: "string" } },
});
if (!values.python || !values.platform || !/^[a-z0-9-]+$/.test(values.platform))
  throw new Error("Use --python INTERPRETER --platform TARGET");
const python = resolve(values.python),
  directory = resolve(root, "packaging/dist", values.platform),
  work = resolve(root, "packaging/build", values.platform);
const result = spawnSync(
  python,
  [
    "-c",
    'import json,sysconfig; print(json.dumps({"platform":sysconfig.get_platform()}))',
  ],
  { encoding: "utf8", windowsHide: true },
);
if (result.status !== 0)
  throw new Error(result.stderr || "Could not inspect Python architecture");
const architecture = /arm64|aarch64/i.test(JSON.parse(result.stdout).platform)
  ? "arm64"
  : "x64";
if (process.arch !== architecture)
  throw new Error("Node and Python must have the same target architecture");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13))
  throw new Error("Node.js 22.13+ is required");
for (const file of ["backend/dist/index.cjs", "desktop/dist/index.html"])
  if (!existsSync(join(root, file))) throw new Error(`Build ${file} first`);
mkdirSync(directory, { recursive: true });
mkdirSync(work, { recursive: true });
const extension = process.platform === "win32" ? ".exe" : "",
  node = join(directory, "flyscan-sidecar" + extension),
  transport = join(directory, "flyscan-transport" + extension);
const started = Date.now();
const frozen = spawnSync(
  python,
  [
    "-m",
    "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onefile",
    "--name",
    "flyscan-transport",
    "--collect-all",
    "curl_cffi",
    "--distpath",
    directory,
    "--workpath",
    work,
    "--specpath",
    work,
    join(root, "flyscan/transport.py"),
  ],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
if (
  frozen.status !== 0 ||
  !existsSync(transport) ||
  statSync(transport).mtimeMs < started - 2000
)
  throw new Error("The curl transport was not rebuilt");
copyFileSync(process.execPath, node);
utimesSync(node, new Date(), new Date());
chmodSync(node, 0o755);
mkdirSync(join(directory, "backend"), { recursive: true });
copyFileSync(
  join(root, "backend/dist/index.cjs"),
  join(directory, "backend/index.cjs"),
);
cpSync(join(root, "desktop/dist"), join(directory, "frontend"), {
  recursive: true,
});
console.log(`Prepared Node backend and curl-only transport: ${directory}`);
