/**
 * End-to-end: drives the built `rynk` CLI exactly as a user would, against
 * real daemons, real processes and real HTTP clients. Each daemon gets its own
 * home, ports and name so two can run on one machine as separate "laptops".
 *
 * Needs a prior `pnpm build`. Discovery runs over UDP only (on a random port)
 * so the test doesn't interfere with real mDNS traffic on the host.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../../packages/cli/dist/bin.js", import.meta.url));
const built = fs.existsSync(BIN);
const rand = (lo: number, span: number) => lo + Math.floor(Math.random() * span);
const DISCOVERY_PORT = rand(27_000, 900);

function node(name: string, base: number) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `rynk-e2e-${name}-`));
  return {
    name,
    home,
    env: {
      ...process.env,
      RYNK_HOME: home,
      RYNK_NODE_NAME: name,
      RYNK_DAEMON_PORT: String(base),
      RYNK_PROXY_PORT: String(base + 1),
      RYNK_NODE_PORT: String(base + 2),
      RYNK_DISCOVERY: "udp",
      RYNK_DISCOVERY_PORT: String(DISCOVERY_PORT),
      ...(process.platform !== "win32" ? { RYNK_DISCOVERY_INTERFACES: "127.0.0.1" } : {}),
      RYNK_PORT_MIN: String(base + 10),
      RYNK_PORT_MAX: String(base + 99),
      RYNK_APP_PORT_MIN: String(base + 100),
      RYNK_APP_PORT_MAX: String(base + 199),
      RYNK_POPUP: "off",
      CI: "1",
    } as NodeJS.ProcessEnv,
  };
}

function rynk(n: ReturnType<typeof node>, args: string[], cwd = n.home): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: n.env, cwd, timeout: 120_000 }, (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) }));
  });
}
const json = async <T = any>(n: ReturnType<typeof node>, args: string[], cwd?: string): Promise<T> => {
  const r = await rynk(n, [...args, "--json"], cwd);
  try {
    return JSON.parse(r.out) as T;
  } catch {
    throw new Error(`rynk ${args.join(" ")} did not print JSON (code ${r.code}):\n${r.out}\n${r.err}`);
  }
};

const APP = `
const http = require("node:http");
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  if (req.url === "/crash") { res.end("bye"); setTimeout(() => process.exit(3), 20); return; }
  if (req.url === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("data: first\\n\\n");
    const t = setInterval(() => res.write("data: tick\\n\\n"), 200);
    req.on("close", () => clearInterval(t));
    return;
  }
  res.end("app " + process.pid);
});
server.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
  socket.on("data", (d) => socket.write(d));
});
server.listen(port, process.env.HOST || "127.0.0.1", () => console.log("listening on http://localhost:" + port));
`;

function get(url: string, ua: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    http.get(url, { headers: { "user-agent": ua } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", () => resolve({ status: 0, body: "" }));
  });
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 20_000, every = 300): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error("timed out");
}

const A = node("laptop-a", rand(20_000, 3000));
const B = node("laptop-b", A.env.RYNK_DAEMON_PORT ? Number(A.env.RYNK_DAEMON_PORT) + 500 : 25_000);
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "rynk-e2e-app-"));
fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "frontend", version: "1.0.0", scripts: { start: "node server.js" } }));
fs.writeFileSync(path.join(appDir, "server.js"), APP);
const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), "rynk-e2e-site-"));
fs.writeFileSync(path.join(siteDir, "index.html"), "<h1>backend docs on laptop B</h1>");

let share = "";

describe.skipIf(!built)("rynk end to end (real CLI, real daemons)", () => {
  beforeAll(async () => {
    const r = await json(A, ["start", "--lan", "--max-users", "10", "--non-interactive", "--no-install", "--port", String(Number(A.env.RYNK_DAEMON_PORT) + 10)], appDir);
    expect(r.status).toBe("live");
    share = r.url;
  }, 120_000);

  afterAll(async () => {
    await rynk(A, ["daemon", "stop"]);
    await rynk(B, ["daemon", "stop"]);
  }, 60_000);

  it("`rynk start --json` reports a live, reachable share link", async () => {
    expect(share).toMatch(/^http:\/\/[\d.]+:\d+$/);
    const s = await json(A, ["status", "frontend"]);
    expect(s).toMatchObject({ status: "live", project: "frontend", maxUsers: 10, activeUsers: 0 });
    expect(s.url).toBe(share);
    expect(s.hostingSessionId).toMatch(/^hs_/);
    const r = await get(share, "probe");
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/^app \d+$/);
  });

  it("allows 10 clients, rejects the 11th, and frees a slot on disconnect", async () => {
    for (const s of (await json(A, ["clients", "frontend"])).sessions) await rynk(A, ["clients", "disconnect", s.sessionId]); // start empty
    const codes: number[] = [];
    for (let i = 1; i <= 11; i++) codes.push((await get(share, `laptop-${i}`)).status);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(codes[10]).toBe(503);
    const c = await json(A, ["clients", "frontend"]);
    expect(c.active).toBe(10);
    expect(c.limit).toBe(10);
    expect(new Set(c.sessions.map((s: { userAgent: string }) => s.userAgent)).size).toBe(10);
    const victim = c.sessions.find((s: { userAgent: string }) => s.userAgent === "laptop-3");
    const d = await rynk(A, ["clients", "disconnect", victim.sessionId]);
    expect(d.code).toBe(0);
    expect((await get(share, "laptop-11")).status).toBe(200); // the freed slot goes to the waiting client
    expect((await get(share, "laptop-13")).status).toBe(503); // and the room is full again
  });

  it("changes the limit live with `rynk limit`", async () => {
    expect((await rynk(A, ["limit", "0", "frontend"])).code).toBe(0);
    expect((await get(share, "laptop-12")).status).toBe(200);
  });

  it("streams SSE and passes WebSockets through the share link", async () => {
    const u = new URL(share);
    const first = await new Promise<string>((resolve) => {
      const req = http.get({ host: u.hostname, port: u.port, path: "/sse", headers: { "user-agent": "sse" } }, (res) => res.once("data", (d) => (resolve(String(d)), req.destroy())));
    });
    expect(first).toContain("data: first");
    const echoed = await new Promise<string>((resolve) => {
      const s = net.connect(Number(u.port), u.hostname, () => s.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nUser-Agent: ws\r\n\r\n"));
      let stage = 0;
      s.on("data", (d) => {
        if (stage++ === 0) s.write("hello-over-gateway");
        else (resolve(String(d)), s.destroy());
      });
    });
    expect(echoed).toBe("hello-over-gateway");
  });

  it("restarts a crashed app and keeps the same share link", async () => {
    const pidBefore = (await get(share, "probe")).body;
    await get(`${share}/crash`, "probe");
    const back = await until(async () => {
      const r = await get(share, "probe");
      return r.status === 200 && r.body !== pidBefore ? r : undefined;
    }, 30_000);
    expect(back.body).toMatch(/^app \d+$/);
    const s = await until(async () => {
      const cur = await json(A, ["status", "frontend"]);
      return cur.status === "live" ? cur : undefined;
    }, 15_000);
    expect(s.url).toBe(share);
    expect(s.deployment.restartCount).toBeGreaterThanOrEqual(1);
  }, 40_000);

  it("`rynk plan` and `rynk inspect` describe the project without side effects", async () => {
    const plan = await json(A, ["plan", appDir]);
    expect(plan.project.name).toBe("frontend");
    expect(plan.packageManager).toBe("npm");
    expect(plan.capabilities).toHaveProperty("supportsPortEnv");
    expect(plan.running).toBe("LIVE");
    const ins = await json(A, ["inspect", "frontend"]);
    expect(ins.project.deployment.hostingSession.shareUrl).toBe(share);
  });

  it("two laptops discover each other, verify identities and list each other's apps", async () => {
    const b = await json(B, ["start", "--name", "backend-docs", "--non-interactive"], siteDir);
    expect(b.status).toBe("live");
    const seen = await until(async () => {
      const nodes = await json<Array<{ name: string; verified?: boolean; self?: boolean; status: string; apps: Array<{ name: string; url: string }> }>>(A, ["nodes"]);
      const nb = nodes.find((n) => n.name === "laptop-b");
      return nb && nb.apps.some((a) => a.name === "backend-docs") ? nb : undefined;
    }, 30_000, 1000);
    expect(seen.verified).toBe(true);
    expect(seen.status).toBe("ONLINE");
    const apps = await json<Array<{ name: string; url: string; node: { name: string } }>>(A, ["apps"]);
    const docs = apps.find((a) => a.name === "backend-docs")!;
    expect(docs.node.name).toBe("laptop-b");
    expect((await get(docs.url, "from-laptop-a")).body).toContain("backend docs on laptop B");
    // …and B sees A's app too.
    const fromB = await until(async () => (await json<Array<{ name: string }>>(B, ["apps"])).find((a) => a.name === "frontend"), 20_000, 1000);
    expect(fromB).toBeTruthy();
  }, 90_000);

  it("marks a laptop offline when it leaves", async () => {
    await rynk(B, ["daemon", "stop"]);
    const gone = await until(async () => {
      const nb = (await json<Array<{ name: string; status: string }>>(A, ["nodes"])).find((n) => n.name === "laptop-b");
      return nb && nb.status !== "ONLINE" ? nb : undefined;
    }, 20_000, 1000);
    expect(gone.status).toBe("OFFLINE");
  }, 30_000);
});
