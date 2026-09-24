/**
 * DNS-rebinding and CSRF protection for the local daemon API.
 * A request is only accepted when its Host header names a loopback address
 * (or an explicitly allowed host) and, for browsers, its Origin matches.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0] ?? null;
}

export function isAllowedHost(hostHeader: string | undefined, extra: string[] = []): boolean {
  const h = hostnameOf(hostHeader);
  if (!h) return false;
  return LOOPBACK.has(h) || extra.map((e) => e.toLowerCase()).includes(h);
}

export function isAllowedOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
  extra: string[] = [],
): boolean {
  if (!origin) return true; // non-browser clients (CLI) send no Origin
  try {
    const u = new URL(origin);
    return isAllowedHost(u.host, extra) && (!hostHeader || u.host === hostHeader);
  } catch {
    return false;
  }
}
