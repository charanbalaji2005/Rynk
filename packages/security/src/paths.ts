import fs from "node:fs";
import path from "node:path";

/** True when `child` resolves inside `parent` (after symlink resolution when possible). */
export function isInside(parent: string, child: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      const dir = path.dirname(p);
      if (dir && dir !== p) {
        return path.join(real(dir), path.basename(p));
      }
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(parent), real(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Paths that must never be served by the static runtime or passed through
 * the proxy, regardless of what the application does.
 */
const SENSITIVE_SEGMENTS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.svn(\/|$)/i,
  /(^|\/)\.hg(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)rynk\.db(-wal|-shm)?$/i,
  /\.(sqlite3?|db)(-wal|-shm)?$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml)$/i,
];

export function isSensitivePath(urlPath: string): boolean {
  let p: string;
  try {
    p = decodeURIComponent(urlPath.split("?")[0] ?? "");
  } catch {
    return true; // malformed encodings are rejected outright
  }
  p = p.replace(/\\/g, "/");
  if (p.includes("\0")) return true;
  return SENSITIVE_SEGMENTS.some((re) => re.test(p));
}
