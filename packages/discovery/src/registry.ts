import type { RynkApp, RynkNode } from "@rynk/core";
import { nodeIdFromPublicKey, verifyBody } from "./identity.js";
import type { Announcement, DiscoveryProvider } from "./types.js";

export interface RegistryOptions {
  providers: DiscoveryProvider[];
  /** Current description of this node (apps, addresses, rev). */
  self: () => RynkNode;
  onEvent?: (kind: "discovered" | "updated" | "lost", node: RynkNode) => void;
  onWarn?: (msg: string) => void;
  /** Heartbeat thresholds. */
  onlineMs?: number;
  unreachableMs?: number;
  purgeMs?: number;
  sweepMs?: number;
  fetchNode?: (a: { address: string; apiPort: number; nodeId: string }) => Promise<RynkNode | null>;
}

const MAX_BODY = 256 * 1024;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

/** Validate a node description fetched from another machine. */
export function sanitizeNode(raw: unknown, expectedId: string, address: string, apiPort: number): RynkNode | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.nodeId !== expectedId) return null;
  const apps: RynkApp[] = (Array.isArray(o.apps) ? o.apps : []).slice(0, 200).flatMap((a): RynkApp[] => {
    if (!a || typeof a !== "object") return [];
    const x = a as Record<string, unknown>;
    const url = str(x.url, 300);
    if (!/^https?:\/\/[^\s]+$/.test(url)) return [];
    const port = Number(x.port);
    return [{
      id: str(x.id, 64),
      name: str(x.name, 64),
      ...(x.framework ? { framework: str(x.framework, 40) } : {}),
      runtime: str(x.runtime, 20),
      url,
      port: Number.isInteger(port) ? port : 0,
      status: str(x.status, 20),
      access: x.access === "protected" ? "protected" : "open",
    }];
  });
  return {
    nodeId: expectedId,
    name: str(o.name, 63) || "rynk-node",
    hostname: str(o.hostname, 255),
    address,
    addresses: (Array.isArray(o.addresses) ? o.addresses : []).filter((x): x is string => typeof x === "string").slice(0, 16),
    apiPort,
    platform: str(o.platform, 20),
    arch: str(o.arch, 20),
    version: str(o.version, 20),
    rev: Number(o.rev) || 0,
    capabilities: (Array.isArray(o.capabilities) ? o.capabilities : []).filter((x): x is string => typeof x === "string").slice(0, 32),
    apps,
    status: "ONLINE",
    lastSeen: Date.now(),
  };
}

const MAX_CLOCK_SKEW_MS = 10 * 60_000;

/**
 * Fetch and authenticate a node's description: the body must be signed by the
 * key whose hash *is* the announced node id, and be recent. Anything else is
 * rejected, so no machine can impersonate another node id.
 */
export async function fetchVerifiedNode(a: { address: string; apiPort: number; nodeId: string }): Promise<RynkNode | null> {
  const res = await fetch(`http://${a.address}:${a.apiPort}/rynk/v1/node`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > MAX_BODY) return null;
  const raw = JSON.parse(text) as { publicKey?: unknown; issuedAt?: unknown };
  const sig = res.headers.get("x-rynk-signature");
  if (typeof raw.publicKey !== "string" || !sig) throw new NodeAuthError("unsigned node description");
  if (nodeIdFromPublicKey(raw.publicKey) !== a.nodeId) throw new NodeAuthError("node id doesn't match its key");
  if (!verifyBody(raw.publicKey, text, sig)) throw new NodeAuthError("bad signature");
  if (typeof raw.issuedAt !== "number" || Math.abs(Date.now() - raw.issuedAt) > MAX_CLOCK_SKEW_MS) throw new NodeAuthError("stale or clock-skewed description");
  const node = sanitizeNode(raw, a.nodeId, a.address, a.apiPort);
  return node ? { ...node, verified: true, publicKey: raw.publicKey } : null;
}

export class NodeAuthError extends Error {}

/**
 * Everything this node knows about other Rynk nodes. Announcements from any
 * provider (UDP, mDNS…) are merged by node id — never by IP, since addresses
 * change. Full details are fetched only when a node's `rev` changes. Liveness
 * is a TTL: ONLINE → UNREACHABLE → OFFLINE, with a cheap HTTP ping before a
 * node that stopped beaconing (e.g. multicast filtered) is demoted.
 */
export class NodeRegistry {
  private nodes = new Map<string, RynkNode>();
  private inflight = new Set<string>();
  private pendingVia = new Map<string, Set<string>>();
  private rejected = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private providerState = new Map<string, { ok: boolean; error?: string }>();

  constructor(private readonly o: RegistryOptions) {}

  private get fetchNode() {
    return this.o.fetchNode ?? fetchVerifiedNode;
  }

  async start() {
    await Promise.all(
      this.o.providers.map(async (p) => {
        try {
          p.onNodeDiscovered((a) => void this.onAnnouncement(a));
          p.onNodeLost((id) => this.markLost(id));
          await p.start();
          this.providerState.set(p.name, { ok: true });
        } catch (e) {
          this.providerState.set(p.name, { ok: false, error: (e as Error).message });
          this.o.onWarn?.(`Discovery provider ${p.name} unavailable: ${(e as Error).message}`);
        }
      }),
    );
    await this.announce();
    this.timer = setInterval(() => void this.sweep(), this.o.sweepMs ?? 5_000);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(this.o.providers.filter((p) => this.providerState.get(p.name)?.ok).map((p) => p.stop()));
  }

  /** Re-announce this node (call after apps, rev or address change). */
  async announce() {
    const self = this.o.self();
    const ann = { nodeId: self.nodeId, name: self.name, address: self.address, apiPort: self.apiPort, rev: self.rev, version: self.version };
    await Promise.allSettled(this.o.providers.filter((p) => this.providerState.get(p.name)?.ok).map((p) => p.advertise(ann)));
  }

  /** Ask every provider who is out there, then return the full list. */
  async discover(): Promise<RynkNode[]> {
    const found = await Promise.allSettled(this.o.providers.filter((p) => this.providerState.get(p.name)?.ok).map((p) => p.discover()));
    await Promise.allSettled(found.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).map((a) => this.onAnnouncement(a)));
    return this.list();
  }

  providers() {
    return this.o.providers.map((p) => ({ name: p.name, ...(this.providerState.get(p.name) ?? { ok: false, error: "not started" }) }));
  }

  list(opts: { includeSelf?: boolean } = { includeSelf: true }): RynkNode[] {
    const others = [...this.nodes.values()].sort((a, b) => a.name.localeCompare(b.name));
    return opts.includeSelf === false ? others : [{ ...this.o.self(), self: true, status: "ONLINE", lastSeen: Date.now() }, ...others];
  }

  get(id: string) {
    return this.nodes.get(id);
  }

  private async onAnnouncement(a: Announcement) {
    const existing = this.nodes.get(a.nodeId);
    const now = Date.now();
    if (existing) {
      existing.lastSeen = now;
      existing.via = [...new Set([...(existing.via ?? []), a.via])];
      const wasDown = existing.status !== "ONLINE";
      existing.status = "ONLINE";
      if (existing.rev === a.rev && existing.address === a.address) {
        if (wasDown) this.o.onEvent?.("updated", existing);
        return;
      }
    }
    if (this.inflight.has(a.nodeId)) {
      // Another provider announced the same node while we fetch its details.
      const set = this.pendingVia.get(a.nodeId) ?? new Set<string>();
      set.add(a.via);
      this.pendingVia.set(a.nodeId, set);
      return;
    }
    this.inflight.add(a.nodeId);
    try {
      let full: RynkNode | null = null;
      try {
        full = await this.fetchNode(a);
      } catch (e) {
        if (e instanceof NodeAuthError) {
          // Refuse to list a node that can't prove its identity.
          if (!this.rejected.has(a.nodeId)) this.o.onWarn?.(`Ignoring node ${a.name} at ${a.address}: ${e.message}`);
          this.rejected.add(a.nodeId);
          this.nodes.delete(a.nodeId);
          return;
        }
      }
      const node: RynkNode = full ?? {
        nodeId: a.nodeId, name: a.name, hostname: a.name, address: a.address, addresses: [a.address], apiPort: a.apiPort,
        platform: "", arch: "", version: a.version, rev: a.rev, capabilities: [], apps: [], status: "ONLINE", lastSeen: now,
      };
      node.via = [...new Set([...(existing?.via ?? []), a.via, ...(this.pendingVia.get(a.nodeId) ?? [])])];
      this.pendingVia.delete(a.nodeId);
      node.lastSeen = Date.now();
      // Only accept the fetched rev if we got details; otherwise refetch next time.
      if (!full) node.rev = existing?.rev ?? -1;
      this.nodes.set(a.nodeId, node);
      this.o.onEvent?.(existing ? "updated" : "discovered", node);
    } finally {
      this.inflight.delete(a.nodeId);
    }
  }

  private markLost(id: string) {
    const n = this.nodes.get(id);
    if (!n || n.status === "OFFLINE") return;
    n.status = "OFFLINE";
    n.apps = n.apps.map((a) => ({ ...a, status: "OFFLINE" }));
    this.o.onEvent?.("lost", n);
  }

  private async sweep() {
    const now = Date.now();
    const online = this.o.onlineMs ?? 15_000;
    const unreachable = this.o.unreachableMs ?? 60_000;
    const purge = this.o.purgeMs ?? 3_600_000;
    for (const n of [...this.nodes.values()]) {
      const age = now - n.lastSeen;
      if (age > purge) {
        this.nodes.delete(n.nodeId);
        continue;
      }
      // A node that left (goodbye or TTL) stays OFFLINE until it announces itself again.
      if (n.status === "OFFLINE") continue;
      if (age > online * 0.8 && !this.inflight.has(n.nodeId)) {
        // Beacons stopped arriving. Before demoting, try the node directly.
        this.inflight.add(n.nodeId);
        const fresh = await this.fetchNode(n).catch(() => null);
        this.inflight.delete(n.nodeId);
        if (fresh) {
          const changed = fresh.rev !== n.rev;
          Object.assign(n, fresh, { via: n.via, lastSeen: Date.now(), status: "ONLINE" });
          if (changed) this.o.onEvent?.("updated", n);
          continue;
        }
      }
      const next: RynkNode["status"] = age < online ? "ONLINE" : age < unreachable ? "UNREACHABLE" : "OFFLINE";
      if (next !== n.status) {
        if (next === "OFFLINE") this.markLost(n.nodeId);
        else {
          n.status = next;
          this.o.onEvent?.("updated", n);
        }
      }
    }
  }
}
