import http from "node:http";
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccessGateway } from "../src/index.js";

let app: http.Server;
let appPort: number;
const seenCookies: Array<string | undefined> = [];

beforeAll(async () => {
  app = http.createServer((req, res) => {
    seenCookies.push(req.headers.cookie);
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hi\n\n");
      return; // keep open
    }
    res.setHeader("set-cookie", "app=1; Path=/");
    res.end(`app:${req.url}:${req.headers["x-forwarded-for"]}`);
  });
  app.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d)); // echo
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  appPort = (app.address() as net.AddressInfo).port;
});
afterAll(() => app.close());

let gw: AccessGateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

async function start(policy: Partial<{ maxUsers: number; mode: "open" | "protected"; idleTimeoutMs: number }> = {}) {
  gw = new AccessGateway({ listenHost: "127.0.0.1", listenPort: 0, target: { host: "127.0.0.1", port: appPort }, policy: { mode: "open", maxUsers: 0, idleTimeoutMs: 60_000, advertise: true, clientRetentionMs: 600_000, ...policy } });
  await gw.start();
  return gw;
}

/** A tiny browser: keeps its own cookie jar. */
function browser(ua: string) {
  const jar = new Map<string, string>();
  return async (path = "/", extra: Record<string, string> = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: gw!.port, path, headers: { "user-agent": ua, ...(cookie ? { cookie } : {}), ...extra } }, (res) => {
        for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
          const [kv] = c.split(";");
          const [k, v] = kv!.split("=");
          if (v) jar.set(k!, v);
          else jar.delete(k!);
        }
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      }).on("error", reject);
    });
  };
}

describe("AccessGateway", () => {
  it("proxies to the app and preserves its own cookies", async () => {
    await start();
    const r = await browser("a")("/hello");
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/^app:\/hello:127\.0\.0\.1/);
    expect(String(r.headers["set-cookie"])).toContain("app=1");
    expect(String(r.headers["set-cookie"])).toContain(`__rynk_${gw!.port}=`);
  });

  it("never forwards Rynk's session cookie to the app", async () => {
    await start();
    const b = browser("a");
    await b("/");
    seenCookies.length = 0;
    await b("/again");
    expect(seenCookies.at(-1) ?? "").not.toContain("__rynk_");
  });

  it("counts one session per browser, not per request", async () => {
    await start({ maxUsers: 5 });
    const b = browser("a");
    for (let i = 0; i < 10; i++) await b(`/asset${i}.js`);
    expect(gw!.stats().active).toBe(1);
  });

  it("enforces the maximum number of active users", async () => {
    await start({ maxUsers: 2 });
    const [a, b, c] = [browser("a"), browser("b"), browser("c")];
    expect((await a()).status).toBe(200);
    expect((await b()).status).toBe(200);
    const denied = await c("/", { accept: "text/html" });
    expect(denied.status).toBe(503);
    expect(denied.body).toContain("maximum number of active users");
    expect(denied.body).not.toMatch(/rynk|127\.0\.0\.1/i);
    expect((await a("/more")).status).toBe(200); // existing users are unaffected
  });

  it("frees a slot when a session goes idle", async () => {
    await start({ maxUsers: 1, idleTimeoutMs: 200 });
    const [a, b] = [browser("a"), browser("b")];
    expect((await a()).status).toBe(200);
    expect((await b()).status).toBe(503);
    await new Promise((r) => setTimeout(r, 300));
    expect((await b()).status).toBe(200);
  });

  it("keeps a session active while a stream is open", async () => {
    await start({ maxUsers: 1, idleTimeoutMs: 100 });
    const req = http.get({ host: "127.0.0.1", port: gw!.port, path: "/sse", headers: { "user-agent": "streamer" } });
    await new Promise((r) => req.once("response", r));
    await new Promise((r) => setTimeout(r, 250));
    expect(gw!.stats().active).toBe(1);
    expect((await browser("other")()).status).toBe(503);
    req.destroy();
  });

  it("disconnects and optionally blocks a client", async () => {
    await start();
    const a = browser("a");
    await a();
    const id = gw!.sessions()[0]!.sessionId;
    gw!.table.end(id, { block: true });
    expect((await a()).status).toBe(403);
    expect((await browser("fresh")()).status).toBe(403); // same address is blocked
    gw!.table.unblock("127.0.0.1");
    expect((await browser("fresh")()).status).toBe(200);
  });

  it("requires an invite in protected mode; invites are single-use and hidden from the URL", async () => {
    await start({ mode: "protected" });
    const { token } = gw!.table.createInvite(60_000, 1);
    const guest = browser("guest");
    expect((await browser("stranger")()).status).toBe(401);
    const r = await guest(`/page?x=1&rynk_access=${token}`);
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/page?x=1");
    expect((await guest("/page?x=1")).status).toBe(200);
    expect((await browser("second")(`/?rynk_access=${token}`)).status).toBe(403);
  });

  it("rejects revoked and expired invites", async () => {
    await start({ mode: "protected" });
    const a = gw!.table.createInvite(60_000, 5);
    gw!.table.revokeInvite(a.invite.id);
    expect((await browser("x")(`/?rynk_access=${a.token}`)).status).toBe(403);
    const b = gw!.table.createInvite(10, 5);
    await new Promise((r) => setTimeout(r, 30));
    expect((await browser("y")(`/?rynk_access=${b.token}`)).status).toBe(403);
  });

  it("blocks sensitive paths and shows a restarting page while the app restarts", async () => {
    await start();
    expect((await browser("a")("/.env")).status).toBe(404);
    gw!.setAvailable(false);
    const r = await browser("a")("/", { accept: "text/html" });
    expect(r.status).toBe(503);
    expect(r.body).toContain("Restarting");
    gw!.setAvailable(true);
    expect((await browser("a")()).status).toBe(200);
  });

  it("passes WebSocket upgrades through and tracks them as open connections", async () => {
    await start({ maxUsers: 3 });
    const sock = net.connect(gw!.port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nUser-Agent: ws\r\n\r\n");
    const first = await new Promise<string>((r) => sock.once("data", (d) => r(String(d))));
    expect(first).toContain("101");
    sock.write("ping");
    expect(await new Promise<string>((r) => sock.once("data", (d) => r(String(d))))).toBe("ping");
    expect(gw!.sessions()[0]!.openConnections).toBe(1);
    gw!.table.end(gw!.sessions()[0]!.sessionId);
    await new Promise((r) => sock.once("close", r));
  });

  it("answers Rynk's own reachability probe without creating a session", async () => {
    await start({ maxUsers: 1 });
    const probe = await browser("rynk-health")("/", { "x-rynk-probe": gw!.probeToken });
    expect(probe.status).toBe(204);
    expect(gw!.stats().active).toBe(0);
    expect((await browser("wrong")("/", { "x-rynk-probe": "guess" })).status).toBe(200); // a wrong token is just a normal visitor
  });

  it("reports that the share port is busy", async () => {
    const blocker = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = (blocker.address() as net.AddressInfo).port;
    const g = new AccessGateway({ listenHost: "127.0.0.1", listenPort: port, target: { host: "127.0.0.1", port: appPort }, policy: { mode: "open", maxUsers: 0, idleTimeoutMs: 1000, advertise: true, clientRetentionMs: 600_000 } });
    await expect(g.start()).rejects.toThrow(/already in use/);
    blocker.close();
  });
});

describe("abuse protection", () => {
  async function startLimited(limits: Record<string, number>) {
    gw = new AccessGateway({ listenHost: "127.0.0.1", listenPort: 0, target: { host: "127.0.0.1", port: appPort }, policy: { mode: "open", maxUsers: 0, idleTimeoutMs: 60_000, advertise: true, clientRetentionMs: 600_000 }, limits });
    await gw.start();
  }
  const post = (body: string | Buffer, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: gw!.port, method: "POST", path: "/upload", headers: { "user-agent": "up", ...headers } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      req.on("error", () => resolve(0));
      req.end(body);
    });

  it("rate-limits a client that floods the host", async () => {
    await startLimited({ burst: 5, ratePerSecond: 1 });
    const b = browser("flood");
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await b(`/${i}`)).status);
    expect(codes.slice(0, 5).every((x) => x === 200)).toBe(true);
    expect(codes.slice(5)).toContain(429);
  });

  it("rejects oversized requests, declared or streamed", async () => {
    await startLimited({ maxBodyBytes: 1024 });
    expect(await post("x".repeat(100))).toBe(200);
    expect(await post("x".repeat(5000))).toBe(413);
    expect([413, 0]).toContain(await post(Buffer.alloc(5000), { "transfer-encoding": "chunked" }));
  });

  it("caps concurrent requests per session", async () => {
    await startLimited({ maxConcurrentPerSession: 2 });
    const open = [0, 1].map(() => http.get({ host: "127.0.0.1", port: gw!.port, path: "/sse", headers: { "user-agent": "same" } }));
    await Promise.all(open.map((r) => new Promise((res) => r.once("response", res))));
    expect((await browser("same")("/x")).status).toBe(429);
    open.forEach((r) => r.destroy());
  });

  it("caps WebSockets per session", async () => {
    await startLimited({ maxSocketsPerSession: 1 });
    const upgrade = () => new Promise<string>((resolve) => {
      const s = net.connect(gw!.port, "127.0.0.1", () => s.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nUser-Agent: wsx\r\n\r\n"));
      s.once("data", (d) => resolve(String(d).split("\r\n")[0]!));
    });
    expect(await upgrade()).toContain("101");
    expect(await upgrade()).toContain("429");
  });
});
