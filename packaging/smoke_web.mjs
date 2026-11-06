import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
export async function smokeWeb(base = "http://127.0.0.1:8080") {
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      const r = await fetch(base + "/v1/health", {
        signal: AbortSignal.timeout(2000),
        redirect: "manual",
      });
      assert.equal(r.status, 200);
      break;
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await delay(250);
    }
  }
  assert.equal((await fetch(base + "/", { redirect: "manual" })).status, 200);
  const identity = await (await fetch(base + "/v1/version")).json();
  assert.equal(identity.mode, "web");
  const sources = new Set(
    (await (await fetch(base + "/v1/sources")).json()).map((s) => s.name),
  );
  assert.ok(
    sources.size && !sources.has("momondo") && !sources.has("ff-kayak"),
  );
  console.log(
    `Web container passed: ${identity.version}, bundled UI and source policy.`,
  );
}
await smokeWeb(process.argv[2]);
