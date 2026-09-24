import http from "node:http";
import net from "node:net";
import { isSensitivePath } from "@rynk/security";
import type { ProxyProvider, ProxyRoute } from "./types.js";

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection"];
const ROUTE_COOKIE = "rynk_route";

function isLoopback(addr: string | undefined) {
  return !!addr && (addr === "::1" || addr.startsWith("127.") || addr === "::ffff:127.0.0.1");
}

function cookie(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export interface Match {
  route: ProxyRoute;
  /** Path forwarded upstream (prefix stripped when matched by path). */
  path: string;
  via: "host" | "path" | "referer" | "cookie";
}

/**
 * Zero-dependency reverse proxy.
 *  - Host routing:  http://portfolio.localhost:7777/
 *  - Path routing:  http://192.168.1.15:7777/portfolio/
 * Apps that emit absolute asset URLs (/assets/app.js) still work under a
 * path prefix: the proxy remembers which project the browser was using via
 * a scoped cookie and the Referer header.
 */
export class BuiltinProxy implements ProxyProvider {
  readonly name = "builtin";
  private routes = new Map<string, ProxyRoute>();
  private server: http.Server | undefined;
  private sockets = new Set<net.Socket>();

  constructor(
    private readonly listenPort: number,
    private readonly listenHost = "0.0.0.0",
    private readonly onRequest?: (info: { route?: string; status: number; ms: number }) => void,
  ) {}

  get port() {
    return this.listenPort;
  }

  match(req: Pick<http.IncomingMessage, "headers" | "url">): Match | undefined {
    const url = req.url ?? "/";
    const host = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
    for (const r of this.routes.values()) {
      if (r.hostnames.includes(host)) return { route: r, path: url, via: "host" };
    }
    const byPrefix = [...this.routes.values()]
      .filter((r) => url === r.pathPrefix || url.startsWith(r.pathPrefix + "/") || url.startsWith(r.pathPrefix + "?"))
      .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];
    if (byPrefix) {
      const rest = url.slice(byPrefix.pathPrefix.length) || "/";
      return { route: byPrefix, path: rest.startsWith("/") ? rest : "/" + rest, via: "path" };
    }
    const ref = req.headers.referer;
    if (ref) {
      try {
        const refPath = new URL(ref).pathname;
        const r = [...this.routes.values()].find((x) => refPath === x.pathPrefix || refPath.startsWith(x.pathPrefix + "/"));
        if (r) return { route: r, path: url, via: "referer" };
      } catch {
        /* bad referer */
      }
    }
    const c = cookie(req as http.IncomingMessage, ROUTE_COOKIE);
    const r = c ? [...this.routes.values()].find((x) => x.name === c) : undefined;
    if (r) return { route: r, path: url, via: "cookie" };
    return undefined;
  }

  private forwardHeaders(req: http.IncomingMessage, m: Match): http.OutgoingHttpHeaders {
    const h: http.OutgoingHttpHeaders = { ...req.headers };
    for (const k of HOP_BY_HOP) delete h[k];
    const prior = req.headers["x-forwarded-for"];
    h["x-forwarded-for"] = [prior, req.socket.remoteAddress].filter(Boolean).join(", ");
    h["x-forwarded-host"] = req.headers.host ?? "";
    h["x-forwarded-proto"] = "http";
    if (m.via === "path") h["x-forwarded-prefix"] = m.route.pathPrefix;
    return h;
  }

  private indexPage(res: http.ServerResponse) {
    const items = [...this.routes.values()]
      .map((r) => `<li><a href="${r.pathPrefix}/">${r.name}</a> <small>→ :${r.targetPort}</small></li>`)
      .join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset=utf-8><title>Rynk proxy</title><style>body{font:16px system-ui;margin:3rem;max-width:40rem}small{color:#777}</style><h1>Rynk</h1>${items ? `<ul>${items}</ul>` : "<p>No projects are live. Run <code>rynk</code> in a project folder.</p>"}`);
  }

  private handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const t0 = Date.now();
    const m = this.match(req);
    if (!m) {
      if ((req.url ?? "/") === "/") return this.indexPage(res);
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("No Rynk project matches this address.\n");
    }
    if (!m.route.lan && !isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("This project is only available on this machine.\n");
    }
    if (isSensitivePath(m.path)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not Found\n");
    }
    const upstream = http.request(
      { host: m.route.targetHost, port: m.route.targetPort, method: req.method, path: m.path, headers: this.forwardHeaders(req, m), timeout: 60_000 },
      (up) => {
        const headers = { ...up.headers };
        for (const k of HOP_BY_HOP) delete headers[k];
        // Rewrite redirects that point at the upstream back through the prefix.
        if (m.via === "path" && typeof headers.location === "string" && headers.location.startsWith("/") && !headers.location.startsWith("//")) {
          headers.location = m.route.pathPrefix + headers.location;
        }
        if (m.via === "path") {
          const set = headers["set-cookie"] ?? [];
          headers["set-cookie"] = [...(Array.isArray(set) ? set : [set]), `${ROUTE_COOKIE}=${encodeURIComponent(m.route.name)}; Path=/; SameSite=Lax; HttpOnly`];
        }
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
        up.on("end", () => this.onRequest?.({ route: m.route.name, status: up.statusCode ?? 0, ms: Date.now() - t0 }));
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Rynk couldn't reach ${m.route.name} on port ${m.route.targetPort} (${(e as NodeJS.ErrnoException).code ?? e.message}).\nRun: rynk logs ${m.route.name}\n`);
      this.onRequest?.({ route: m.route.name, status: 502, ms: Date.now() - t0 });
    });
    req.pipe(upstream);
  };

  /** WebSocket / HMR passthrough via raw socket piping. */
  private upgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const m = this.match(req);
    if (!m || (!m.route.lan && !isLoopback(req.socket.remoteAddress))) return socket.destroy();
    const up = net.connect(m.route.targetPort, m.route.targetHost, () => {
      const headers = Object.entries(req.headers)
        .filter(([k]) => k !== "x-forwarded-for")
        .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]));
      up.write(`${req.method} ${m.path} HTTP/1.1\r\n${headers.join("\r\n")}\r\nx-forwarded-for: ${req.socket.remoteAddress}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const close = () => {
      up.destroy();
      socket.destroy();
    };
    up.on("error", close);
    socket.on("error", close);
  };

  async start(): Promise<void> {
    if (this.server) return;
    const srv = http.createServer(this.handle);
    srv.on("upgrade", this.upgrade);
    srv.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    srv.headersTimeout = 30_000;
    srv.requestTimeout = 0; // streaming responses (SSE) must not be cut off
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(this.listenPort, this.listenHost, () => resolve());
    });
    this.server = srv;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = undefined;
  }

  async register(route: ProxyRoute) {
    this.routes.set(route.id, route);
  }
  async remove(id: string) {
    this.routes.delete(id);
  }
  async list() {
    return [...this.routes.values()];
  }
  async reload() {
    /* routes are live in memory; nothing to reload */
  }
}
