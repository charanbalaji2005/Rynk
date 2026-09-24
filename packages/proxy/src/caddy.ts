import type { ProxyProvider, ProxyRoute } from "./types.js";

/**
 * Drives an existing Caddy instance through its admin API
 * (default http://127.0.0.1:2019). Useful when you want Caddy's automatic
 * HTTPS or already run Caddy. Enable with RYNK_PROXY=caddy.
 */
export class CaddyProxy implements ProxyProvider {
  readonly name = "caddy";
  private routes = new Map<string, ProxyRoute>();

  constructor(readonly port: number, private readonly adminUrl = "http://127.0.0.1:2019") {}

  async start() {
    const r = await fetch(`${this.adminUrl}/config/`).catch(() => null);
    if (!r?.ok) throw new Error(`Caddy admin API not reachable at ${this.adminUrl}`);
    await this.reload();
  }

  async stop() {}

  async register(route: ProxyRoute) {
    this.routes.set(route.id, route);
    await this.reload();
  }
  async remove(id: string) {
    this.routes.delete(id);
    await this.reload();
  }
  async list() {
    return [...this.routes.values()];
  }

  toConfig() {
    const routes = [...this.routes.values()].flatMap((r) => [
      { match: [{ host: r.hostnames }], handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${r.targetHost}:${r.targetPort}` }] }] },
      {
        match: [{ path: [`${r.pathPrefix}/*`, r.pathPrefix] }],
        handle: [
          { handler: "rewrite", strip_path_prefix: r.pathPrefix },
          { handler: "reverse_proxy", upstreams: [{ dial: `${r.targetHost}:${r.targetPort}` }], headers: { request: { set: { "X-Forwarded-Prefix": [r.pathPrefix] } } } },
        ],
      },
    ]);
    return { apps: { http: { servers: { rynk: { listen: [`:${this.port}`], routes, automatic_https: { disable: true } } } } } };
  }

  async reload() {
    const r = await fetch(`${this.adminUrl}/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(this.toConfig()) });
    if (!r.ok) throw new Error(`Caddy rejected config: ${await r.text()}`);
  }
}
