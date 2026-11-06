import assert from "node:assert/strict";
import { test } from "node:test";
import { pythonArchitecture } from "../build-architecture.mjs";

test("Python build architecture handles universal macOS and Windows emulation", () => {
  assert.equal(pythonArchitecture("macosx-10.13-universal2", "arm64"), "arm64");
  assert.equal(pythonArchitecture("macosx-10.13-universal2", "x86_64"), "x64");
  assert.equal(pythonArchitecture("macosx-11.0-arm64", "arm64"), "arm64");
  assert.equal(pythonArchitecture("win-amd64", "ARM64"), "x64");
  assert.equal(pythonArchitecture("win-arm64", "ARM64"), "arm64");
  assert.equal(pythonArchitecture("linux-aarch64", "aarch64"), "arm64");
  assert.equal(pythonArchitecture("linux-x86_64", "x86_64"), "x64");
  assert.throws(() => pythonArchitecture("linux-i686", "i686"), /Unsupported/);
});
