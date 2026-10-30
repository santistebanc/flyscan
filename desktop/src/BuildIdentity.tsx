import { useEffect, useState } from "react";
import type { FlyscanApi } from "./api";
import { isDesktop } from "./platform";

export function BuildIdentity({ api }: { api: FlyscanApi | null }) {
  const [identity, setIdentity] = useState<Awaited<ReturnType<FlyscanApi["version"]>> | null>(null);
  useEffect(() => {
    let active = true;
    if (api) void api.version().then(value => { if (active) setIdentity(value); }).catch(() => {});
    return () => { active = false; };
  }, [api]);
  return <div className="build-identity muted" aria-label="Application version">
    Flyscan {identity?.version ?? "—"} · {identity ? identity.edition[0]!.toUpperCase() + identity.edition.slice(1) : "Connecting"} · {isDesktop ? "Desktop" : "Web"}
  </div>;
}
