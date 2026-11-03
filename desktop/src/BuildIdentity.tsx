import { useEffect, useState } from "react";
import type { FlyscanApi } from "./api";
import { isDesktop } from "./platform";

type Identity = Awaited<ReturnType<FlyscanApi["version"]>>;

/** The version, small under the logo; the full build reads on hover. */
export function BuildIdentity({ api }: { api: FlyscanApi | null }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  useEffect(() => {
    let active = true;
    if (api) void api.version().then(value => { if (active) setIdentity(value); }).catch(() => {});
    return () => { active = false; };
  }, [api]);
  if (!identity) return null;
  const full = `Flyscan ${identity.version} · ${isDesktop ? "Desktop" : "Web"}`;
  return <span className="build-identity" title={full} aria-label={full}>{identity.version}</span>;
}
