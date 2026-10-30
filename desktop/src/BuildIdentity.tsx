import { useEffect, useState } from "react";
import type { FlyscanApi } from "./api";
import { isDesktop } from "./platform";

type Identity = Awaited<ReturnType<FlyscanApi["version"]>>;

/** "0.3.9", or "0.3.9X" for the private edition. */
export function versionLabel(identity: Identity): string {
  return identity.version + (identity.edition === "private" ? "X" : "");
}

/** The version, small under the logo; the full build reads on hover. */
export function BuildIdentity({ api }: { api: FlyscanApi | null }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  useEffect(() => {
    let active = true;
    if (api) void api.version().then(value => { if (active) setIdentity(value); }).catch(() => {});
    return () => { active = false; };
  }, [api]);
  if (!identity) return null;
  const edition = identity.edition[0]!.toUpperCase() + identity.edition.slice(1);
  const full = `Flyscan ${identity.version} · ${edition} · ${isDesktop ? "Desktop" : "Web"}`;
  return <span className="build-identity" title={full} aria-label={full}>{versionLabel(identity)}</span>;
}
