import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const [directory, platform, version, signature, ...rest] =
    process.argv.slice(2),
  split = rest.indexOf("--");
if (!directory || !platform || split < 0)
  throw new Error(
    "Expected DIRECTORY PLATFORM VERSION SIGNATURE FILES... -- UPDATE=FILE...",
  );
const files = Object.fromEntries(
  rest.slice(0, split).map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(join(directory, name)))
      .digest("hex"),
  ]),
);
const updates = Object.fromEntries(
  rest.slice(split + 1).map((entry) => {
    const index = entry.indexOf("=");
    if (index < 1) throw new Error("Invalid update asset");
    return [entry.slice(0, index), entry.slice(index + 1)];
  }),
);
const info = {
  version,
  platform,
  files,
  updates,
  signature,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  uncommittedChanges: !!execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim(),
  builtAtUtc: new Date().toISOString(),
};
writeFileSync(
  join(directory, `build-info-${platform}.json`),
  JSON.stringify(info, null, 2) + "\n",
);
