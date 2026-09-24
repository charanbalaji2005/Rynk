import makeMdns from "multicast-dns";
import { SERVICE_TYPE, type Announcement, type DiscoveryProvider } from "./types.js";
import { parseAnnouncement } from "./validate.js";

type Self = Omit<Announcement, "via">;
type Mdns = ReturnType<typeof makeMdns>;
type Answer = { name: string; type: string; ttl?: number; data: unknown };

const txtToObject = (data: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const b of Array.isArray(data) ? data : [data]) {
    const s = Buffer.isBuffer(b) ? b.toString("utf8") : String(b ?? "");
    const i = s.indexOf("=");
    if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
};

/**
 * Standards-based discovery via mDNS / DNS-SD (`_rynk._tcp.local`), the same
 * mechanism printers and AirPlay use, so it works with Bonjour (macOS), Avahi
 * (Linux) and the Windows mDNS stack. Records carry only id, rev and version.
 */
export class MdnsDiscovery implements DiscoveryProvider {
  readonly name = "mdns";
  private mdns: Mdns | undefined;
  private self: Self | undefined;
  private timer: NodeJS.Timeout | undefined;
  private seen = new Map<string, Announcement>();
  private receivedAt = new Map<string, number>();
  private found: Array<(a: Announcement) => void> = [];
  private lost: Array<(id: string) => void> = [];

  constructor(private readonly opts: { announceEveryMs?: number } = {}) {}

  private instance(s: Self) {
    return `${s.name}-${s.nodeId.slice(-6)}.${SERVICE_TYPE}`;
  }
  private target(s: Self) {
    return `${s.nodeId}.local`;
  }

  private records(s: Self, ttl: number): Answer[] {
    const inst = this.instance(s);
    return [
      { name: SERVICE_TYPE, type: "PTR", ttl, data: inst },
      { name: inst, type: "SRV", ttl, data: { port: s.apiPort, weight: 0, priority: 10, target: this.target(s) } },
      { name: inst, type: "TXT", ttl, data: [`id=${s.nodeId}`, `n=${s.name}`, `r=${s.rev}`, `v=${s.version}`, `p=${s.apiPort}`] },
      { name: this.target(s), type: "A", ttl, data: s.address },
    ];
  }

  async start() {
    const m = makeMdns({ reuseAddr: true, loopback: true });
    m.on("query", (q: { questions: Array<{ name: string; type: string }> }) => {
      if (!this.self) return;
      if (q.questions.some((x) => x.name === SERVICE_TYPE || x.name === this.instance(this.self!))) {
        m.respond({ answers: this.records(this.self, 120) as never });
      }
    });
    m.on("response", (r: { answers?: Answer[]; additionals?: Answer[] }, rinfo: { address: string }) => this.onResponse([...(r.answers ?? []), ...(r.additionals ?? [])], rinfo.address));
    m.on("error", () => undefined);
    this.mdns = m;
    m.query({ questions: [{ name: SERVICE_TYPE, type: "PTR" }] });
    const every = this.opts.announceEveryMs ?? 60_000;
    this.timer = setInterval(() => {
      if (this.self) m.respond({ answers: this.records(this.self, 120) as never });
    }, every);
    this.timer.unref();
  }

  private onResponse(answers: Answer[], from: string) {
    const txts = answers.filter((a) => a.type === "TXT");
    for (const t of txts) {
      if (!t.name.endsWith(SERVICE_TYPE)) continue;
      const kv = txtToObject(t.data);
      if (kv.id === this.self?.nodeId) continue;
      if (t.ttl === 0) {
        if (kv.id) {
          this.seen.delete(kv.id);
          for (const fn of this.lost) fn(kv.id);
        }
        continue;
      }
      const aRec = answers.find((a) => a.type === "A" && typeof a.data === "string");
      const a = parseAnnouncement({ id: kv.id, n: kv.n, r: kv.r, v: kv.v, p: kv.p, a: aRec?.data }, from, this.name);
      if (!a) continue;
      this.seen.set(a.nodeId, a);
      this.receivedAt.set(a.nodeId, Date.now());
      for (const fn of this.found) fn(a);
    }
  }

  async advertise(self: Self) {
    const changed = !this.self || this.self.rev !== self.rev || this.self.address !== self.address;
    this.self = self;
    if (changed) this.mdns?.respond({ answers: this.records(self, 120) as never });
  }

  async discover() {
    const since = Date.now();
    this.mdns?.query({ questions: [{ name: SERVICE_TYPE, type: "PTR" }] });
    await new Promise((r) => setTimeout(r, 800));
    return [...this.seen.values()].filter((a) => (this.receivedAt.get(a.nodeId) ?? 0) >= since);
  }

  onNodeDiscovered(cb: (a: Announcement) => void) {
    this.found.push(cb);
  }
  onNodeLost(cb: (id: string) => void) {
    this.lost.push(cb);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    const m = this.mdns;
    if (!m) return;
    if (this.self) m.respond({ answers: this.records(this.self, 0) as never }); // goodbye
    await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((r) => m.destroy(() => r()));
    this.mdns = undefined;
  }
}
