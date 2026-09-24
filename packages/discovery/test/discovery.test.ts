import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RynkNode } from "@rynk/core";
import { loadIdentity, NodeInfoServer, NodeRegistry, parseAnnouncement, sanitizeNode, UdpDiscovery, type Announcement, type DiscoveryProvider } from "../src/index.js";

const node = (id: string, name: string, rev = 1, apiPort = 7780): RynkNode => ({
  nodeId: id, name, hostname: name, address: "127.0.0.1", addresses: ["127.0.0.1"], apiPort, platform: "linux", arch: "x64", version: "0.2.0", rev,
  capabilities: ["host"], apps: [{ id: "p1", name: `${name}-app`, runtime: "native", url: "http://127.0.0.1:5173", port: 5173, status: "LIVE", access: "open" }], status: "ONLINE", lastSeen: Date.now(),
});
const A = "rynk-node-aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "rynk-node-bbbbbbbbbbbbbbbbbbbbbbbb";

/** A provider we can drive by hand. */
class FakeProvider implements DiscoveryProvider {
  readonly name = "fake";
  found: Array<(a: Announcement) => void> = [];
  lost: Array<(id: string) => void> = [];
  advertised: Array<Omit<Announcement, "via">> = [];
  async start() {}
  async stop() {}
  async advertise(a: Omit<Announcement, "via">) {
    this.advertised.push(a);
  }
  async discover() {
    return [];
  }
  onNodeDiscovered(cb: (a: Announcement) => void) {
    this.found.push(cb);
  }
  onNodeLost(cb: (id: string) => void) {
    this.lost.push(cb);
  }
  announce(a: Partial<Announcement> & { nodeId: string }) {
    for (const fn of this.found) fn({ name: "n", address: "127.0.0.1", apiPort: 7780, rev: 1, version: "0.2.0", via: "fake", ...a });
  }
}

describe("identity", () => {
  it("creates a persistent node id with owner-only permissions", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rynk-id-"));
    const a = loadIdentity(home);
    expect(a.nodeId).toMatch(/^rynk-node-[0-9a-f]{24}$/);
    expect(loadIdentity(home).nodeId).toBe(a.nodeId);
    if (process.platform !== "win32") expect(fs.statSync(path.join(home, "node.json")).mode & 0o077).toBe(0);
  });
});

describe("wire validation", () => {
  it("accepts well-formed announcements and prefers the packet's source address", () => {
    const a = parseAnnouncement({ id: A, n: "laptop-a", p: 7780, r: 3, a: "10.0.0.9", v: "0.2.0" }, "192.168.1.42", "udp");
    expect(a).toMatchObject({ nodeId: A, name: "laptop-a", address: "192.168.1.42", apiPort: 7780, rev: 3 });
  });
  it.each([[{ id: "evil", p: 7780 }], [{ id: A, p: 99999 }], [{ id: A, p: 80, r: -1 }], [null], ["string"]])("drops %j", (x) => {
    expect(parseAnnouncement(x, "192.168.1.42", "udp")).toBeNull();
  });
  it("sanitizes fetched node descriptions", () => {
    const n = sanitizeNode({ nodeId: A, name: "x".repeat(500), apps: [{ name: "ok", url: "http://1.2.3.4:80" }, { name: "bad", url: "javascript:alert(1)" }] }, A, "1.2.3.4", 7780);
    expect(n?.name.length).toBeLessThanOrEqual(63);
    expect(n?.apps.map((a) => a.name)).toEqual(["ok"]);
    expect(sanitizeNode({ nodeId: B }, A, "1.2.3.4", 7780)).toBeNull(); // id must match the announcement
  });
});

describe("NodeRegistry", () => {
  let reg: NodeRegistry | undefined;
  afterEach(async () => reg?.stop());

  it("discovers, fetches details once per rev, and advertises itself", async () => {
    const p = new FakeProvider();
    let fetches = 0;
    const events: string[] = [];
    reg = new NodeRegistry({ providers: [p], self: () => node(A, "self"), fetchNode: async (a) => (fetches++, node(a.nodeId, "laptop-b", 1)), onEvent: (k, n) => events.push(`${k}:${n.name}`) });
    await reg.start();
    expect(p.advertised[0]?.nodeId).toBe(A);
    p.announce({ nodeId: B, rev: 1 });
    await new Promise((r) => setTimeout(r, 20));
    p.announce({ nodeId: B, rev: 1 }); // heartbeat, no refetch
    await new Promise((r) => setTimeout(r, 20));
    expect(fetches).toBe(1);
    expect(reg.list().map((n) => n.name)).toEqual(["self", "laptop-b"]);
    expect(reg.get(B)?.apps[0]?.name).toBe("laptop-b-app");
    p.announce({ nodeId: B, rev: 2 }); // apps changed → refetch
    await new Promise((r) => setTimeout(r, 20));
    expect(fetches).toBe(2);
    expect(events).toEqual(["discovered:laptop-b", "updated:laptop-b"]);
  });

  it("goes ONLINE → UNREACHABLE → OFFLINE without heartbeats, and back on recovery", async () => {
    const p = new FakeProvider();
    let alive = true;
    reg = new NodeRegistry({ providers: [p], self: () => node(A, "self"), fetchNode: async (a) => (alive ? node(a.nodeId, "b") : null), onlineMs: 100, unreachableMs: 250, sweepMs: 30 });
    await reg.start();
    p.announce({ nodeId: B });
    await new Promise((r) => setTimeout(r, 20));
    alive = false;
    await new Promise((r) => setTimeout(r, 170));
    expect(reg.get(B)?.status).toBe("UNREACHABLE");
    await new Promise((r) => setTimeout(r, 200));
    expect(reg.get(B)?.status).toBe("OFFLINE");
    alive = true;
    p.announce({ nodeId: B });
    await new Promise((r) => setTimeout(r, 20));
    expect(reg.get(B)?.status).toBe("ONLINE");
  });

  it("keeps a node alive by HTTP ping when beacons are filtered", async () => {
    const p = new FakeProvider();
    reg = new NodeRegistry({ providers: [p], self: () => node(A, "self"), fetchNode: async (a) => node(a.nodeId, "b"), onlineMs: 100, unreachableMs: 250, sweepMs: 30 });
    await reg.start();
    p.announce({ nodeId: B });
    await new Promise((r) => setTimeout(r, 300));
    expect(reg.get(B)?.status).toBe("ONLINE");
  });

  it("marks a node offline on goodbye and keeps it offline until it returns", async () => {
    const p = new FakeProvider();
    reg = new NodeRegistry({ providers: [p], self: () => node(A, "self"), fetchNode: async (a) => node(a.nodeId, "b"), sweepMs: 20 });
    await reg.start();
    p.announce({ nodeId: B });
    await new Promise((r) => setTimeout(r, 20));
    for (const fn of p.lost) fn(B);
    expect(reg.get(B)?.status).toBe("OFFLINE");
    await new Promise((r) => setTimeout(r, 100)); // several sweeps with a recent lastSeen
    expect(reg.get(B)?.status).toBe("OFFLINE");
    p.announce({ nodeId: B, rev: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(reg.get(B)?.status).toBe("ONLINE");
  });

  it("isolates a failing provider", async () => {
    class Broken extends FakeProvider {
      override readonly name = "broken" as never;
      override async start() {
        throw new Error("no multicast");
      }
    }
    const broken = new Broken();
    const warnings: string[] = [];
    reg = new NodeRegistry({ providers: [broken, new FakeProvider()], self: () => node(A, "self"), onWarn: (m) => warnings.push(m) });
    await reg.start();
    expect(reg.providers().find((p) => p.name === "broken")?.ok).toBe(false);
    expect(warnings[0]).toMatch(/no multicast/);
  });
});

describe("real transports", () => {
  it("serves read-only node info with ETags and nothing else", async () => {
    const server = new NodeInfoServer(() => node(A, "self", 7), { port: 17_700, host: "127.0.0.1" });
    await server.start();
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/rynk/v1/node`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as RynkNode;
      expect(body.nodeId).toBe(A);
      expect(JSON.stringify(body)).not.toMatch(/token|secret/i);
      expect((await fetch(`http://127.0.0.1:${server.port}/rynk/v1/node`, { headers: { "if-none-match": '"7"' } })).status).toBe(304);
      expect((await fetch(`http://127.0.0.1:${server.port}/api/projects`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${server.port}/rynk/v1/node`, { method: "POST" })).status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("two UDP nodes find each other and say goodbye", async () => {
    const port = 17_800 + Math.floor(Math.random() * 100);
    const iface = () => ["127.0.0.1"];
    const a = new UdpDiscovery({ port, intervalMs: 200, interfaces: iface });
    const b = new UdpDiscovery({ port, intervalMs: 200, interfaces: iface });
    const seen: string[] = [];
    const lost: string[] = [];
    a.onNodeDiscovered((x) => seen.push(x.name));
    a.onNodeLost((id) => lost.push(id));
    try {
      await a.start();
      await b.start();
    } catch (e) {
      console.warn(`skipping: multicast unavailable (${(e as Error).message})`);
      return;
    }
    await a.advertise({ nodeId: A, name: "laptop-a", address: "127.0.0.1", apiPort: 1, rev: 1, version: "0.2.0" });
    await b.advertise({ nodeId: B, name: "laptop-b", address: "127.0.0.1", apiPort: 2, rev: 1, version: "0.2.0" });
    const found = await a.discover();
    expect(found.map((x) => x.nodeId)).toContain(B);
    expect(seen).toContain("laptop-b");
    await b.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(lost).toContain(B);
    await a.stop();
  });
});

describe("node authentication", () => {
  it("derives the node id from the key and verifies signed descriptions", async () => {
    const { loadIdentity: load, nodeIdFromPublicKey, fetchVerifiedNode } = await import("../src/index.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rynk-auth-"));
    const id = load(home);
    expect(id.nodeId).toBe(nodeIdFromPublicKey(id.publicKey));
    const server = new NodeInfoServer(() => ({ ...node(id.nodeId, "signed"), apiPort: 0 }), { port: 17_720, host: "127.0.0.1", identity: id });
    await server.start();
    try {
      const n = await fetchVerifiedNode({ address: "127.0.0.1", apiPort: server.port, nodeId: id.nodeId });
      expect(n).toMatchObject({ nodeId: id.nodeId, verified: true, publicKey: id.publicKey });
      // Someone else announcing *this* node id with their own key is rejected.
      const imposter = load(fs.mkdtempSync(path.join(os.tmpdir(), "rynk-imp-")));
      const fake = new NodeInfoServer(() => ({ ...node(id.nodeId, "imposter"), apiPort: 0 }), { port: 17_740, host: "127.0.0.1", identity: imposter });
      await fake.start();
      await expect(fetchVerifiedNode({ address: "127.0.0.1", apiPort: fake.port, nodeId: id.nodeId })).rejects.toThrow(/doesn't match|signature/);
      await fake.stop();
      // Unsigned descriptions (no identity) are rejected too.
      const unsigned = new NodeInfoServer(() => node(id.nodeId, "unsigned"), { port: 17_760, host: "127.0.0.1" });
      await unsigned.start();
      await expect(fetchVerifiedNode({ address: "127.0.0.1", apiPort: unsigned.port, nodeId: id.nodeId })).rejects.toThrow(/unsigned/);
      await unsigned.stop();
    } finally {
      await server.stop();
    }
  });
  it("replaces legacy identities without a key", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rynk-legacy-"));
    fs.writeFileSync(path.join(home, "node.json"), JSON.stringify({ nodeId: "rynk-node-aaaaaaaaaaaaaaaaaaaaaaaa", createdAt: 1 }));
    const id = loadIdentity(home);
    expect(id.publicKey).toBeTruthy();
    expect(id.nodeId).not.toBe("rynk-node-aaaaaaaaaaaaaaaaaaaaaaaa");
  });
});
