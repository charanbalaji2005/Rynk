import net from "node:net";
import { DEFAULTS, RynkError } from "@rynk/core";

/** Try to bind; true when nothing else holds the port on this host. */
export function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", (e: NodeJS.ErrnoException) => {
      // An address family this machine doesn't support can't conflict.
      resolve(e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL");
    });
    srv.listen({ port, host, exclusive: true, ...(host === "::" ? { ipv6Only: true } : {}) }, () => srv.close(() => resolve(true)));
  });
}

/**
 * A port counts as free only if it's bindable on the wildcard AND loopback
 * addresses (IPv4 + IPv6). Apps bind to different ones, so checking just one
 * produces false "free" results.
 */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of ["0.0.0.0", "127.0.0.1", "::"]) {
    if (!(await canBind(port, host))) return false;
  }
  return true;
}

/** True when something accepts TCP connections on host:port. */
export function isListening(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export interface PortStore {
  load(): Promise<Map<string, number>> | Map<string, number>;
  save(projectId: string, port: number): Promise<void> | void;
  remove(projectId: string): Promise<void> | void;
}

export class MemoryPortStore implements PortStore {
  private m = new Map<string, number>();
  load() { return new Map(this.m); }
  save(id: string, p: number) { this.m.set(id, p); }
  remove(id: string) { this.m.delete(id); }
}

// Ports that are commonly reserved by other tooling; skipped when scanning.
const AVOID = new Set([3306, 5432, 5672, 6379, 8888, 9000, 9090, 9200, 9229, 9876, 7777, 27017]);

/**
 * Allocates ports with:
 *  - sticky mappings (a project keeps its port across restarts when free),
 *  - in-process reservations serialized through a mutex (no double-allocation races),
 *  - OS-level verification before handing a port out.
 */
export class PortAllocator {
  private reserved = new Map<number, string>(); // port → projectId
  private sticky = new Map<string, number>(); // projectId → port
  private lock: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(
    private readonly store: PortStore = new MemoryPortStore(),
    private readonly range: [number, number] = [DEFAULTS.portRangeStart, DEFAULTS.portRangeEnd],
    private readonly probe: (port: number) => Promise<boolean> = isPortFree,
  ) {}

  private async ensureLoaded() {
    if (this.loaded) return;
    this.sticky = new Map(await this.store.load());
    this.loaded = true;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  reservedBy(port: number): string | undefined {
    return this.reserved.get(port);
  }

  /**
   * @param preferred  port the project asked for (explicit or framework default)
   * @param strict     when true, fail instead of falling back (user asked for this exact port)
   */
  allocate(projectId: string, preferred?: number, strict = false): Promise<number> {
    return this.exclusive(async () => {
      const port = await this.choose(projectId, preferred, strict);
      return this.reserved.get(port) === projectId && this.sticky.get(projectId) === port ? port : this.commit(projectId, port);
    });
  }

  /** What `allocate` would return right now, without reserving anything (used by `rynk plan`). */
  peek(projectId: string, preferred?: number): Promise<number> {
    return this.exclusive(() => this.choose(projectId, preferred, false));
  }

  private async choose(projectId: string, preferred?: number, strict = false): Promise<number> {
    {
      await this.ensureLoaded();
      const mine = [...this.reserved].find(([, id]) => id === projectId)?.[0];
      if (mine !== undefined && (preferred === undefined || preferred === mine)) return mine;

      const last = this.sticky.get(projectId);

      const tryPort = async (p: number) => {
        if (p < 1 || p > 65535) return false;
        const holder = this.reserved.get(p);
        if (holder && holder !== projectId) return false;
        return this.probe(p);
      };

      const tryPortWithGrace = async (p: number) => {
        // If this project was previously on this exact port, give the OS kernel
        // a brief grace period (up to 200ms) to finish releasing the socket after teardown.
        const retries = last === p ? 4 : 0;
        for (let i = 0; i <= retries; i++) {
          if (await tryPort(p)) return true;
          if (i < retries) await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      };

      if (preferred !== undefined) {
        if (await tryPortWithGrace(preferred)) return preferred;
        if (strict) {
          throw new RynkError("PORT_UNAVAILABLE", `Port ${preferred} is already in use.`, {
            causes: [this.reserved.get(preferred) ? "Another Rynk project is using it." : "Another program on this machine is using it."],
            suggestions: [`rynk start --port ${preferred + 1}`, "rynk status", "rynk doctor"],
            details: { port: preferred },
          });
        }
      }
      if (last !== undefined && last !== preferred && (await tryPortWithGrace(last))) return last;

      // Scan upward from the preferred port (keeps 5173 → 5174 intuitive), then the whole range.
      const start = preferred ?? this.range[0];
      for (let p = start + 1; p <= Math.min(start + 100, this.range[1]); p++) {
        if (!AVOID.has(p) && (await tryPort(p))) return p;
      }
      for (let p = this.range[0]; p <= this.range[1]; p++) {
        if (!AVOID.has(p) && (await tryPort(p))) return p;
      }
      throw new RynkError("PORT_UNAVAILABLE", "No free ports are available in the configured range.", {
        details: { range: this.range },
      });
    }
  }

  private async commit(projectId: string, port: number): Promise<number> {
    for (const [p, id] of this.reserved) if (id === projectId) this.reserved.delete(p);
    this.reserved.set(port, projectId);
    this.sticky.set(projectId, port);
    await this.store.save(projectId, port);
    return port;
  }

  /** Record a port the app chose itself (discovered from output). */
  adopt(projectId: string, port: number): Promise<void> {
    return this.exclusive(async () => {
      await this.commit(projectId, port);
    });
  }

  release(projectId: string): number | undefined {
    for (const [p, id] of this.reserved) {
      if (id === projectId) {
        this.reserved.delete(p);
        return p; // sticky mapping is kept so the next start reuses the port
      }
    }
    return undefined;
  }

  list(): Array<{ port: number; projectId: string }> {
    return [...this.reserved].map(([port, projectId]) => ({ port, projectId }));
  }
}

const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+\.local):(\d{2,5})/i;
const PHRASE_RE = /\b(?:listening|running|serving|started|available|bound)\b[^\n]{0,40}?(?:\bport\b\s*[:=]?\s*|:)(\d{2,5})\b/i;

/** Extract a port from a line of application output, ignoring ANSI colours. */
export function parsePortFromOutput(line: string): number | undefined {
   
  const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const m = URL_RE.exec(clean) ?? PHRASE_RE.exec(clean);
  if (!m) return undefined;
  const p = Number(m[1]);
  return p > 0 && p <= 65535 ? p : undefined;
}
