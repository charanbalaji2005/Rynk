import type { Announcement } from "./types.js";

const ID = /^rynk-node-[0-9a-f]{16,64}$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

/** Strictly validate untrusted wire data. Anything odd is dropped silently. */
export function parseAnnouncement(x: unknown, fallbackAddress: string, via: string): Announcement | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const nodeId = o.id ?? o.nodeId;
  const port = Number(o.p ?? o.apiPort);
  const rev = Number(o.r ?? o.rev ?? 0);
  if (typeof nodeId !== "string" || !ID.test(nodeId)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!Number.isFinite(rev) || rev < 0) return null;
  const name = typeof (o.n ?? o.name) === "string" ? String(o.n ?? o.name).replace(/[^\w.-]/g, "-").slice(0, 63) : "rynk-node";
  const claimed = typeof (o.a ?? o.address) === "string" ? String(o.a ?? o.address) : "";
  // Prefer the address the packet actually came from; fall back to the claim.
  const address = IPV4.test(fallbackAddress) ? fallbackAddress : IPV4.test(claimed) ? claimed : "";
  if (!address) return null;
  const version = typeof (o.v ?? o.version) === "string" ? String(o.v ?? o.version).slice(0, 20) : "?";
  return { nodeId, name, address, apiPort: port, rev, version, via };
}
