import { execFile } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import type { DeploymentURLs, NetworkInterfaceInfo } from "@rynk/core";
import type { EventBus } from "@rynk/events";

export function isPrivateIPv4(a: string): boolean {
  const p = a.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}

export function isCGNAT(a: string): boolean {
  const p = a.split(".").map(Number);
  return p[0] === 100 && p[1]! >= 64 && p[1]! <= 127; // Tailscale & carrier NAT
}

export function isLinkLocal(a: string): boolean {
  return a.startsWith("169.254.") || a.toLowerCase().startsWith("fe80:");
}

export function classifyInterface(name: string): NetworkInterfaceInfo["kind"] {
  const n = name.toLowerCase();
  if (/^lo\d*$|loopback/.test(n)) return "loopback";
  if (/docker|veth|br-|virbr|vmnet|vboxnet|hyper-v|vethernet \(wsl|vethernet \(default|podman|cni|flannel|kube|lxc|lxd|zt|awdl|llw|anpi|ap\d|bridge/.test(n)) return "virtual";
  if (/utun|tun|tap|wg|tailscale|ppp|ipsec|nordlynx|proton|vpn/.test(n)) return "vpn";
  if (/wi-?fi|wlan|wlp|wireless|airport/.test(n)) return "wifi";
  if (/^en\d|eth|enp|eno|ens|ethernet|local area connection/.test(n)) {
    // macOS: en0 is usually Wi-Fi on laptops, but can't be sure; treat as ethernet-class.
    return "ethernet";
  }
  return "unknown";
}

const KIND_SCORE: Record<NetworkInterfaceInfo["kind"], number> = { wifi: 90, ethernet: 100, unknown: 50, vpn: 30, virtual: 5, loopback: 0 };

/**
 * Enumerate usable interfaces, ranked so the address other devices on the
 * LAN can actually reach comes first.
 */
export interface RouteInfo {
  /** Local IPv4 address the OS uses for default-route traffic. */
  source?: string;
  /** Local IPv6 address for default-route traffic, if any. */
  source6?: string;
  /** Default gateway address, when it could be determined. */
  gateway?: string;
}

export interface ListOptions {
  includeIPv6?: boolean;
  route?: RouteInfo;
}

/**
 * Enumerate usable interfaces, ranked so the address other devices on the LAN
 * can actually reach comes first. Signals, strongest first: carries the
 * default route · private address · physical interface kind (Ethernet > Wi-Fi
 * > other > VPN > virtual) · typical LAN ranges. Loopback, 0.0.0.0,
 * link-local (169.254/16, fe80::/10) are never returned.
 */
export function listInterfaces(raw: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(), opts: ListOptions | boolean = {}): NetworkInterfaceInfo[] {
  const o: ListOptions = typeof opts === "boolean" ? { includeIPv6: opts } : opts;
  const out: NetworkInterfaceInfo[] = [];
  for (const [name, addrs] of Object.entries(raw)) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      if (a.family === "IPv6" && !o.includeIPv6) continue;
      if (isLinkLocal(a.address) || a.address === "0.0.0.0" || a.address === "::") continue;
      const kind = classifyInterface(name);
      const priv = a.family === "IPv4" ? isPrivateIPv4(a.address) : /^f[cd]/i.test(a.address);
      const isDefault = a.address === o.route?.source || a.address === o.route?.source6;
      let score = KIND_SCORE[kind];
      if (isDefault) score += 60; // the OS itself says this is the way out
      if (priv) score += 20;
      if (a.family === "IPv4" && a.address.startsWith("192.168.")) score += 5;
      if (a.family === "IPv4" && isCGNAT(a.address)) score -= 10;
      if (a.family === "IPv6") score -= 40; // IPv4 is what LAN URLs and phones expect
      out.push({
        name, address: a.address, family: a.family === "IPv6" ? "IPv6" : "IPv4", kind, private: priv, score,
        ...(isDefault ? { defaultRoute: true } : {}),
        ...(isDefault && a.family === "IPv4" && o.route?.gateway ? { gateway: o.route.gateway } : {}),
        ...(a.cidr ? { cidr: a.cidr } : {}),
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * Which local address would the OS use to reach the internet? Connecting a
 * UDP socket sends no packets but makes the kernel pick a route, which works
 * identically on Windows, macOS and Linux without spawning processes.
 */
export function routeSource(family: "udp4" | "udp6" = "udp4", target = family === "udp4" ? "192.0.2.1" : "2001:db8::1"): Promise<string | undefined> {
  return new Promise((resolve) => {
    const s = dgram.createSocket(family);
    const done = (v?: string) => {
      try {
        s.close();
      } catch {
        /* closed */
      }
      resolve(v);
    };
    s.once("error", () => done());
    try {
      s.connect(53, target, () => {
        try {
          const a = s.address().address;
          done(a && a !== "0.0.0.0" && a !== "::" ? a : undefined);
        } catch {
          done();
        }
      });
    } catch {
      done();
    }
    setTimeout(() => done(), 500).unref();
  });
}

/** Default gateway, best effort: /proc on Linux, `route` on macOS/BSD, `route print` on Windows. */
export async function defaultGateway(): Promise<string | undefined> {
  try {
    if (process.platform === "linux") {
      for (const line of fs.readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f[1] === "00000000" && f[2] && f[2] !== "00000000") {
          const hex = f[2];
          return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(".");
        }
      }
      return undefined;
    }
    const run = (cmd: string, args: string[]) =>
      new Promise<string>((resolve) => execFile(cmd, args, { timeout: 2000, windowsHide: true }, (_e, out) => resolve(String(out ?? ""))));
    if (process.platform === "win32") {
      const out = await run("route", ["print", "0.0.0.0"]);
      return /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m.exec(out)?.[1];
    }
    const out = await run("route", ["-n", "get", "default"]);
    return /gateway:\s*(\S+)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

/** Probe the routing table (cheap; no packets are sent). */
export async function detectRoute(): Promise<RouteInfo> {
  const [source, source6, gateway] = await Promise.all([routeSource("udp4"), routeSource("udp6"), defaultGateway()]);
  return { ...(source ? { source } : {}), ...(source6 ? { source6 } : {}), ...(gateway ? { gateway } : {}) };
}

export function primaryInterface(list = listInterfaces()): NetworkInterfaceInfo | undefined {
  return list.find((i) => i.kind !== "virtual" && i.kind !== "loopback") ?? list[0];
}

function formatHost(h: string) {
  return h.includes(":") ? `[${h}]` : h;
}

export function buildUrls(opts: { port: number; exposure: "local" | "lan" | "public"; interfaces?: NetworkInterfaceInfo[]; proxyUrl?: string; publicUrl?: string; path?: string }): DeploymentURLs {
  const p = opts.path ?? "";
  const urls: DeploymentURLs = { local: `http://localhost:${opts.port}${p}` };
  if (opts.exposure !== "local") {
    const ifaces = (opts.interfaces ?? listInterfaces()).filter((i) => i.kind !== "virtual" && i.kind !== "loopback");
    if (ifaces[0]) urls.network = `http://${formatHost(ifaces[0].address)}:${opts.port}${p}`;
    if (ifaces.length > 1) urls.networkAll = ifaces.map((i) => `http://${formatHost(i.address)}:${opts.port}${p}`);
  }
  if (opts.proxyUrl) urls.proxy = opts.proxyUrl;
  if (opts.publicUrl) urls.public = opts.publicUrl;
  return urls;
}

const signature = (l: NetworkInterfaceInfo[]) => l.map((i) => `${i.name}=${i.address}${i.defaultRoute ? "*" : ""}`).sort().join("|");

/**
 * Watches for network changes (Wi-Fi switch, VPN up/down, DHCP renewals) and
 * publishes `network.changed`. Node has no portable interface-change event,
 * so this uses a cheap, unref'd timer comparing a signature string.
 */
export class NetworkWatcher {
  private timer: NodeJS.Timeout | undefined;
  private route: RouteInfo = {};
  private last: NetworkInterfaceInfo[];
  private checking = false;

  constructor(
    private readonly bus: EventBus,
    private readonly intervalMs = 5_000,
    private readonly source: (route: RouteInfo) => NetworkInterfaceInfo[] = (route) => listInterfaces(os.networkInterfaces(), { route }),
    private readonly probeRoute: () => Promise<RouteInfo> = detectRoute,
  ) {
    this.last = source(this.route);
  }

  current(): NetworkInterfaceInfo[] {
    return this.last;
  }

  routeInfo(): RouteInfo {
    return this.route;
  }

  /** Learn the default route before first use so the initial ranking is right. */
  async init(): Promise<void> {
    this.route = await this.probeRoute().catch(() => ({}));
    this.last = this.source(this.route);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  /** Re-probe the route (async) and then compare interfaces. */
  async refresh(): Promise<boolean> {
    if (this.checking) return false;
    this.checking = true;
    try {
      this.route = await this.probeRoute().catch(() => this.route);
      return this.check();
    } finally {
      this.checking = false;
    }
  }

  check(): boolean {
    const now = this.source(this.route);
    if (signature(now) === signature(this.last)) return false;
    const previous = this.last;
    this.last = now;
    this.bus.emit("network.changed", { previous, current: now, ...(primaryInterface(now) ? { primary: primaryInterface(now)! } : {}) });
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
