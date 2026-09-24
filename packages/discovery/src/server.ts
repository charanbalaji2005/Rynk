import http from "node:http";
import net from "node:net";
import type { RynkNode } from "@rynk/core";
import { RateLimiter } from "@rynk/security";
import { signBody, type NodeIdentity } from "./identity.js";

/**
 * The only thing Rynk serves to the LAN besides your apps: a read-only
 * description of this node (name, platform, advertised apps). There are no
 * control endpoints here — stop/restart/logs exist only on the loopback API.
 */
export class NodeInfoServer {
  private server: http.Server | undefined;
  private limiter = new RateLimiter(60, 10);
  private boundPort = 0;

  constructor(
    private readonly self: () => RynkNode,
    private readonly opts: { port: number; host?: string; identity?: Pick<NodeIdentity, "publicKey" | "privateKey"> },
  ) {}

  get port() {
    return this.boundPort;
  }

  async start() {
    for (let p = this.opts.port; p < this.opts.port + 20; p++) {
      try {
        await this.listen(p);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      }
    }
    throw new Error(`No free port for node info near ${this.opts.port}`);
  }

  private listen(port: number) {
    return new Promise<void>((resolve, reject) => {
      const s = http.createServer((req, res) => this.handle(req, res));
      s.once("error", reject);
      s.listen(port, this.opts.host ?? "0.0.0.0", () => {
        this.server = s;
        this.boundPort = (s.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-cache");
    if (!this.limiter.take(req.socket.remoteAddress ?? "?")) {
      res.writeHead(429).end();
      return;
    }
    if ((req.method !== "GET" && req.method !== "HEAD") || (req.url ?? "").split("?")[0] !== "/rynk/v1/node") {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
      return;
    }
    const node = this.self();
    const etag = `"${node.rev}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag }).end();
      return;
    }
    const { self: _s, via: _v, status: _st, lastSeen: _l, verified: _ve, ...pub } = node;
    const id = this.opts.identity;
    // Signed so other nodes can check it really comes from the owner of this node id.
    const body = JSON.stringify({ ...pub, ...(id ? { publicKey: id.publicKey } : {}), issuedAt: Date.now() });
    const headers: Record<string, string | number> = { "content-type": "application/json", etag, "content-length": Buffer.byteLength(body) };
    if (id) headers["x-rynk-signature"] = signBody(id, body);
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
