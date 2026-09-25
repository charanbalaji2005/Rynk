import dgram from "node:dgram";
import { listInterfaces } from "@rynk/network";
import { DEFAULT_UDP_PORT, MULTICAST_GROUP, type Announcement, type DiscoveryProvider } from "./types.js";
import { parseAnnouncement } from "./validate.js";

type Self = Omit<Announcement, "via">;

/**
 * Lightweight UDP multicast discovery. Each node sends a ~150-byte beacon
 * every `intervalMs` (with jitter) to 239.255.73.79:7779 on every LAN
 * interface; a "query" makes peers answer immediately and a "bye" on shutdown
 * lets them drop us without waiting for the TTL. Doubles as the heartbeat.
 */
export class UdpDiscovery implements DiscoveryProvider {
  readonly name = "udp";
  private socket: dgram.Socket | undefined;
  private self: Self | undefined;
  private timer: NodeJS.Timeout | undefined;
  private seen = new Map<string, Announcement>();
  private receivedAt = new Map<string, number>();
  private found: Array<(a: Announcement) => void> = [];
  private lost: Array<(id: string) => void> = [];

  constructor(private readonly opts: { port?: number; group?: string; intervalMs?: number; interfaces?: () => string[] } = {}) {}

  private get port() {
    return this.opts.port ?? DEFAULT_UDP_PORT;
  }
  private get group() {
    return this.opts.group ?? MULTICAST_GROUP;
  }
  private ifaces() {
    const list = this.opts.interfaces?.() ?? listInterfaces().filter((i) => i.kind !== "virtual").map((i) => i.address);
    if (process.platform !== "win32" && !this.opts.interfaces && !list.includes("127.0.0.1")) {
      list.push("127.0.0.1");
    }
    return list;
  }

  async start() {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (msg, rinfo) => this.onMessage(msg, rinfo));
    sock.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(this.port, () => resolve());
    });
    sock.setMulticastTTL(1); // never leave the local network
    sock.setMulticastLoopback(true); // several nodes on one machine (and tests)
    this.join(sock);
    this.socket = sock;
    this.schedule();
  }

  private join(sock: dgram.Socket) {
    const addrs = this.ifaces();
    let joined = false;
    for (const a of addrs) {
      try {
        sock.addMembership(this.group, a);
        joined = true;
      } catch {
        /* interface without multicast */
      }
    }
    if (!joined) {
      try {
        sock.addMembership(this.group);
      } catch {
        /* no multicast at all: beacons still go out, peers may not answer */
      }
    }
  }

  private schedule() {
    const base = this.opts.intervalMs ?? 5_000;
    this.timer = setTimeout(() => {
      this.send("beacon");
      this.schedule();
    }, base * (0.8 + Math.random() * 0.4));
    this.timer.unref();
  }

  private payload(kind: "beacon" | "query" | "bye") {
    const s = this.self;
    return Buffer.from(JSON.stringify(s ? { t: "rynk", k: kind, id: s.nodeId, n: s.name, p: s.apiPort, r: s.rev, a: s.address, v: s.version } : { t: "rynk", k: kind }));
  }

  private send(kind: "beacon" | "query" | "bye", to?: { address: string; port: number }) {
    const sock = this.socket;
    if (!sock || (kind !== "query" && !this.self)) return;
    const buf = this.payload(kind);
    if (to) return sock.send(buf, to.port, to.address, () => undefined);
    const addrs = this.ifaces();
    for (const a of addrs.length ? addrs : [undefined]) {
      try {
        if (a) sock.setMulticastInterface(a);
        sock.send(buf, this.port, this.group, () => undefined);
      } catch {
        /* interface went away */
      }
    }
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
    if (msg.length > 1024) return;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(msg.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    if (o.t !== "rynk") return;
    if (o.k === "query") {
      if (o.id !== this.self?.nodeId) this.send("beacon");
      return;
    }
    const a = parseAnnouncement(o, rinfo.address, this.name);
    if (!a || a.nodeId === this.self?.nodeId) return;
    if (o.k === "bye") {
      this.seen.delete(a.nodeId);
      for (const fn of this.lost) fn(a.nodeId);
      return;
    }
    this.seen.set(a.nodeId, a);
    this.receivedAt.set(a.nodeId, Date.now());
    for (const fn of this.found) fn(a);
  }

  async advertise(self: Self) {
    const changed = !this.self || this.self.rev !== self.rev || this.self.address !== self.address;
    this.self = self;
    if (changed) this.send("beacon");
  }

  async discover(): Promise<Announcement[]> {
    const since = Date.now();
    this.send("query");
    await new Promise((r) => setTimeout(r, 600));
    // Only answers to *this* query count; cached announcements are not proof of life.
    return [...this.seen.values()].filter((a) => (this.receivedAt.get(a.nodeId) ?? 0) >= since);
  }

  onNodeDiscovered(cb: (a: Announcement) => void) {
    this.found.push(cb);
  }
  onNodeLost(cb: (id: string) => void) {
    this.lost.push(cb);
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.send("bye");
    await new Promise((r) => setTimeout(r, 30));
    await new Promise<void>((r) => (this.socket ? this.socket.close(() => r()) : r()));
    this.socket = undefined;
  }
}
