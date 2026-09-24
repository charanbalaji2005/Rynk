import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { AccessConfig, ClientSession } from "@rynk/core";
import { RynkError } from "@rynk/core";
import { isSensitivePath, RateLimiter } from "@rynk/security";
import { PAGES, TEXT } from "./pages.js";
import { SessionTable, type SessionEvent } from "./sessions.js";

export interface GatewayOptions {
  /** Where people connect: 0.0.0.0 (LAN), 127.0.0.1 (local) or a specific interface address. */
  listenHost: string;
  listenPort: number;
  /** Where the app actually listens (normally loopback). */
  target: { host: string; port: number };
  policy: AccessConfig;
  onSession?: (e: SessionEvent & { active: number; limit: number }) => void;
  onDenied?: (reason: "limit" | "protected" | "blocked" | "ended" | "rate", clientAddress: string) => void;
  limits?: Partial<GatewayLimits>;
}

/** Abuse protection so one client can't exhaust the host. */
export interface GatewayLimits {
  /** Sustained requests per second per client address. */
  ratePerSecond: number;
  /** Burst allowance per client address. */
  burst: number;
  /** In-flight HTTP requests per session. */
  maxConcurrentPerSession: number;
  /** Open WebSocket/upgrade connections per session. */
  maxSocketsPerSession: number;
  /** Open TCP connections to the gateway in total. */
  maxConnections: number;
  /** Largest request body accepted, in bytes. */
  maxBodyBytes: number;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  ratePerSecond: 200,
  burst: 600,
  maxConcurrentPerSession: 64,
  maxSocketsPerSession: 32,
  maxConnections: 2048,
  maxBodyBytes: 256 * 1024 * 1024,
};

const INVITE_PARAM = "rynk_access";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/**
 * The access gateway fronts a hosted app on its share port. It is what makes
 * "maximum active users", invite-only links, client lists and disconnects
 * real rather than cosmetic: every connection passes through it.
 *
 * It exposes no control surface at all — stop/restart/logs/config live only on
 * the loopback daemon API — and it never shows clients anything about Rynk,
 * the host or other clients.
 */
export class AccessGateway {
  readonly table: SessionTable;
  private server: http.Server | undefined;
  private sockets = new Set<net.Socket>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private available = true;
  private agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  private target: { host: string; port: number };
  private boundPort = 0;
  private limiter: RateLimiter;
  private inflight = new Map<string, number>();
  readonly limits: GatewayLimits;
  /** Secret that marks Rynk's own reachability probes so they never count as users. */
  readonly probeToken = crypto.randomBytes(18).toString("base64url");

  constructor(private readonly opts: GatewayOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
    this.limiter = new RateLimiter(this.limits.burst, this.limits.ratePerSecond);
    this.table = new SessionTable(opts.policy);
    this.target = opts.target;
    this.table.onEvent((e) => opts.onSession?.({ ...e, active: this.table.activeCount(), limit: this.table.policy.maxUsers }));
  }

  get port() {
    return this.boundPort || this.opts.listenPort;
  }

  get host() {
    return this.opts.listenHost;
  }

  /** Cookie names ignore ports, so each share port gets its own cookie. */
  private get cookieName() {
    return `__rynk_${this.port}`;
  }

  setTarget(t: { host: string; port: number }) {
    this.target = t;
  }

  /** While false (app restarting), clients get an auto-refreshing "restarting" page. */
  setAvailable(v: boolean) {
    this.available = v;
  }

  setPolicy(p: Partial<AccessConfig>) {
    this.table.policy = { ...this.table.policy, ...p };
  }

  get policy() {
    return this.table.policy;
  }

  sessions(): ClientSession[] {
    return this.table.list();
  }

  stats() {
    return { active: this.table.activeCount(), limit: this.table.policy.maxUsers, blocked: this.table.blockedAddresses().length };
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on("upgrade", (req, socket, head) => this.upgrade(req, socket as net.Socket, head));
    server.maxConnections = this.limits.maxConnections;
    server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    server.on("clientError", (_e, socket) => socket.destroy());
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 20_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", (e: NodeJS.ErrnoException) =>
        reject(e.code === "EADDRINUSE" ? new RynkError("PORT_UNAVAILABLE", `Port ${this.opts.listenPort} is already in use.`, { details: { port: this.opts.listenPort } }) : e),
      );
      server.listen(this.opts.listenPort, this.opts.listenHost, () => resolve());
    });
    this.boundPort = (server.address() as net.AddressInfo).port;
    this.server = server;
    this.sweepTimer = setInterval(() => this.table.sweep(), 5_000);
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.table.clear();
    for (const s of this.sockets) s.destroy();
    this.agent.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = undefined;
  }

  // ── admission ────────────────────────────────────────────
  private cookie(req: http.IncomingMessage): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === this.cookieName) return v.join("=");
    }
    return undefined;
  }

  private stripOwnCookie(header: string | undefined): string | undefined {
    if (!header) return header;
    const kept = header.split(";").map((p) => p.trim()).filter((p) => p && !p.startsWith("__rynk_"));
    return kept.length ? kept.join("; ") : undefined;
  }

  /**
   * Decide whether a request may pass. Returns the session, or a page to show.
   * `inviteToken` is only honoured on plain HTTP navigations.
   */
  private admit(req: http.IncomingMessage, inviteToken?: string):
    | { ok: true; session: ReturnType<SessionTable["create"]>; setCookie: boolean }
    | { ok: false; status: number; page: keyof typeof PAGES; clearCookie?: boolean } {
    const address = req.socket.remoteAddress ?? "unknown";
    const t = this.table;
    if (t.isBlocked(address)) {
      this.opts.onDenied?.("blocked", address);
      return { ok: false, status: 403, page: "blocked" };
    }
    const cookieId = this.cookie(req);
    if (t.isEnded(cookieId)) {
      this.opts.onDenied?.("ended", address);
      return { ok: false, status: 403, page: "ended", clearCookie: true };
    }
    let session = t.get(cookieId);
    const viaCookie = Boolean(session);
    if (!session) session = t.byFingerprint(SessionTable.fingerprint(address, req.headers["user-agent"]));

    let invited = session?.invited ?? false;
    if (inviteToken) {
      if (!t.redeem(inviteToken)) return { ok: false, status: 403, page: "inviteInvalid" };
      invited = true;
      if (session) session.invited = true;
    }
    if (t.policy.mode === "protected" && !invited) {
      this.opts.onDenied?.("protected", address);
      return { ok: false, status: 401, page: "protected" };
    }
    if ((!session || !t.isActive(session)) && !t.hasCapacity()) {
      this.opts.onDenied?.("limit", address);
      return { ok: false, status: 503, page: "limit" };
    }
    if (!session) session = t.create(address, req.headers["user-agent"], invited);
    t.touch(session, viaCookie);
    return { ok: true, session, setCookie: !viaCookie };
  }

  private sendPage(req: http.IncomingMessage, res: http.ServerResponse, status: number, page: keyof typeof PAGES, extra: Record<string, string | string[]> = {}) {
    const wantsHtml = (req.headers.accept ?? "").includes("text/html");
    res.writeHead(status, {
      "content-type": wantsHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...(status === 503 ? { "retry-after": page === "limit" ? "30" : "3" } : {}),
      ...extra,
    });
    res.end(wantsHtml ? PAGES[page]() : TEXT[page]);
  }

  private cookieHeader(id: string) {
    return `${this.cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax`;
  }

  // ── HTTP ─────────────────────────────────────────────────
  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    // Rynk's own "is the share link reachable?" probe: answer directly — no session, no app request.
    const probe = req.headers["x-rynk-probe"];
    if (typeof probe === "string" && probe.length === this.probeToken.length && crypto.timingSafeEqual(Buffer.from(probe), Buffer.from(this.probeToken))) {
      res.writeHead(204, { "cache-control": "no-store" });
      return res.end();
    }
    const addr = req.socket.remoteAddress ?? "unknown";
    if (!this.limiter.take(addr)) {
      this.opts.onDenied?.("rate", addr.replace(/^::ffff:/, ""));
      res.writeHead(429, { "content-type": "text/plain", "retry-after": "1" });
      return res.end("Too many requests.\n");
    }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > this.limits.maxBodyBytes) {
      res.writeHead(413, { "content-type": "text/plain", connection: "close" });
      res.end("Request too large.\n");
      return req.destroy();
    }
    const url = new URL(req.url ?? "/", "http://gateway");
    if (isSensitivePath(decodeURIComponent(url.pathname))) return this.sendPage(req, res, 404, "notFound");

    const token = url.searchParams.get(INVITE_PARAM) ?? undefined;
    const verdict = this.admit(req, token);
    if (!verdict.ok) {
      return this.sendPage(req, res, verdict.status, verdict.page, verdict.clearCookie ? { "set-cookie": `${this.cookieName}=; Path=/; Max-Age=0` } : {});
    }
    const { session } = verdict;
    if (token) {
      // Swap the invite for a session cookie and drop the token from the address bar.
      url.searchParams.delete(INVITE_PARAM);
      res.writeHead(303, { location: url.pathname + (url.search || ""), "set-cookie": this.cookieHeader(session.sessionId), "cache-control": "no-store" });
      return res.end();
    }
    if (!this.available) return this.sendPage(req, res, 503, "restarting");
    const inflight = this.inflight.get(session.sessionId) ?? 0;
    if (inflight >= this.limits.maxConcurrentPerSession) {
      res.writeHead(429, { "content-type": "text/plain", "retry-after": "1" });
      return res.end("Too many simultaneous requests.\n");
    }
    this.inflight.set(session.sessionId, inflight + 1);
    res.on("close", () => {
      const n = (this.inflight.get(session.sessionId) ?? 1) - 1;
      if (n <= 0) this.inflight.delete(session.sessionId);
      else this.inflight.set(session.sessionId, n);
    });

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v;
    const cookie = this.stripOwnCookie(req.headers.cookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    headers["x-forwarded-for"] = [req.headers["x-forwarded-for"], session.clientAddress].filter(Boolean).join(", ");
    headers["x-forwarded-host"] = req.headers.host ?? "";
    headers["x-forwarded-proto"] = "http";

    this.table.beginStream(session);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      this.table.endStream(session);
    };
    res.on("close", done);

    const upstream = http.request(
      { host: this.target.host, port: this.target.port, method: req.method, path: req.url, headers, agent: this.agent },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v;
        if (verdict.setCookie) {
          const existing = out["set-cookie"];
          out["set-cookie"] = [...(Array.isArray(existing) ? existing : existing ? [String(existing)] : []), this.cookieHeader(session.sessionId)];
        }
        res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
        res.flushHeaders();
        up.pipe(res);
        up.on("error", () => res.destroy());
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) this.sendPage(req, res, 502, "unavailable");
      else res.destroy();
    });
    // Enforce the body limit on streamed (chunked) uploads too.
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > this.limits.maxBodyBytes) {
        upstream.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { "content-type": "text/plain", connection: "close" });
          res.end("Request too large.\n");
        }
        req.destroy();
      }
    });
    req.pipe(upstream);
  }

  // ── WebSocket / upgrade passthrough (HMR, live reload, app sockets) ──
  private upgrade(req: http.IncomingMessage, client: net.Socket, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://gateway");
    const reject = (status: number, text: string) => {
      client.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (isSensitivePath(url.pathname)) return reject(404, "Not Found");
    if (!this.limiter.take(req.socket.remoteAddress ?? "unknown")) return reject(429, "Too Many Requests");
    const verdict = this.admit(req);
    if (!verdict.ok) return reject(verdict.status, "Forbidden");
    if (!this.available) return reject(503, "Service Unavailable");
    const { session } = verdict;
    if (this.table.socketCount(session) >= this.limits.maxSocketsPerSession) return reject(429, "Too Many Requests");

    const upstream = net.connect(this.target.port, this.target.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]!;
        if (k.toLowerCase() === "cookie") {
          const c = this.stripOwnCookie(req.rawHeaders[i + 1]);
          if (c) lines.push(`${k}: ${c}`);
          continue;
        }
        if (k.toLowerCase() === "x-forwarded-for") continue;
        lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`X-Forwarded-For: ${session.clientAddress}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const handle = { destroy: () => { client.destroy(); upstream.destroy(); } };
    this.table.attachSocket(session, handle);
    const cleanup = () => {
      this.table.detachSocket(session, handle);
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", cleanup);
    client.on("error", cleanup);
    upstream.on("close", cleanup);
    client.on("close", cleanup);
  }
}
