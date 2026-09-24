import { cmd, RynkError, type ExposureMode } from "@rynk/core";
import { buildUrls, listInterfaces } from "@rynk/network";
import { spawnManaged, which, type ManagedProcess } from "@rynk/process";
import { sanitizeEnv } from "@rynk/security";

export interface ExposureTarget {
  projectId: string;
  name: string;
  port: number;
  host: string;
}

export interface Exposure {
  id: string;
  provider: string;
  url: string;
  mode: ExposureMode;
}

export type ExposureStatus = "active" | "closed" | "error";

export interface ExposureProvider {
  readonly name: string;
  readonly mode: ExposureMode;
  available(): Promise<{ ok: boolean; reason?: string }>;
  create(target: ExposureTarget): Promise<Exposure>;
  destroy(id: string): Promise<void>;
  status(id: string): Promise<ExposureStatus>;
}

/** LAN exposure: no tunnel, just the machine's best private address. */
export class LocalNetworkExposure implements ExposureProvider {
  readonly name = "lan";
  readonly mode = "lan" as const;
  private active = new Set<string>();
  async available() {
    return listInterfaces().length ? { ok: true } : { ok: false, reason: "No active network interface." };
  }
  async create(t: ExposureTarget): Promise<Exposure> {
    const urls = buildUrls({ port: t.port, exposure: "lan" });
    if (!urls.network) throw new RynkError("EXPOSURE_FAILED", "You don't appear to be connected to a network.", { suggestions: ["rynk doctor"] });
    this.active.add(t.projectId);
    return { id: t.projectId, provider: this.name, url: urls.network, mode: "lan" };
  }
  async destroy(id: string) {
    this.active.delete(id);
  }
  async status(id: string): Promise<ExposureStatus> {
    return this.active.has(id) ? "active" : "closed";
  }
}

/**
 * Public URL via Cloudflare Quick Tunnels (`cloudflared tunnel --url`).
 * Requires the `cloudflared` binary; no account needed. Strictly opt-in:
 * only created by `rynk share --public`.
 */
export class CloudflareTunnelExposure implements ExposureProvider {
  readonly name = "cloudflare";
  readonly mode = "public" as const;
  private tunnels = new Map<string, ManagedProcess>();

  async available() {
    return which("cloudflared") ? { ok: true } : { ok: false, reason: "cloudflared is not installed (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)." };
  }

  async create(t: ExposureTarget): Promise<Exposure> {
    const av = await this.available();
    if (!av.ok) throw new RynkError("EXPOSURE_FAILED", "Public sharing needs cloudflared.", { causes: [av.reason!], suggestions: ["brew install cloudflared", "winget install Cloudflare.cloudflared"] });
    await this.destroy(t.projectId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void proc.kill();
        reject(new RynkError("EXPOSURE_FAILED", "Timed out waiting for the public tunnel."));
      }, 30_000);
      const proc = spawnManaged(cmd("cloudflared", "tunnel", "--no-autoupdate", "--url", `http://${t.host.includes(":") ? `[${t.host}]` : t.host || "127.0.0.1"}:${t.port}`), {
        cwd: process.cwd(),
        env: sanitizeEnv(process.env),
        onLine: (line) => {
          const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line);
          if (m) {
            clearTimeout(timer);
            resolve({ id: t.projectId, provider: this.name, url: m[0], mode: "public" });
          }
        },
      });
      this.tunnels.set(t.projectId, proc);
      proc.exited.then(() => {
        clearTimeout(timer);
        this.tunnels.delete(t.projectId);
      });
    });
  }

  async destroy(id: string) {
    const p = this.tunnels.get(id);
    if (p) await p.kill();
    this.tunnels.delete(id);
  }

  async status(id: string): Promise<ExposureStatus> {
    return this.tunnels.get(id)?.alive ? "active" : "closed";
  }
}

/** Extension point for a hosted Rynk relay (https://<id>.rynk.dev). */
export class RynkRelayExposure implements ExposureProvider {
  readonly name = "relay";
  readonly mode = "public" as const;
  async available() {
    return { ok: false, reason: "The Rynk relay service is not available yet." };
  }
  async create(): Promise<Exposure> {
    throw new RynkError("EXPOSURE_FAILED", "The Rynk relay is not available yet.", { suggestions: ["rynk share --public --provider cloudflare"] });
  }
  async destroy() {}
  async status(): Promise<ExposureStatus> {
    return "closed";
  }
}

export class ExposureRegistry {
  private providers = new Map<string, ExposureProvider>();
  constructor(list: ExposureProvider[] = [new LocalNetworkExposure(), new CloudflareTunnelExposure(), new RynkRelayExposure()]) {
    for (const p of list) this.register(p);
  }
  register(p: ExposureProvider) {
    this.providers.set(p.name, p);
  }
  get(name: string): ExposureProvider {
    const p = this.providers.get(name);
    if (!p) throw new RynkError("EXPOSURE_FAILED", `Unknown exposure provider "${name}".`, { suggestions: [`Available: ${[...this.providers.keys()].join(", ")}`] });
    return p;
  }
  defaultPublic(): ExposureProvider {
    return this.get("cloudflare");
  }
  list() {
    return [...this.providers.values()];
  }
}
