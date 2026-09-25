import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Isolate all state before anything reads paths.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rynk-home-"));
process.env.RYNK_HOME = HOME;

import { openDatabase } from "@rynk/database";
import { DetectorRegistry } from "@rynk/detector";
import { EventBus } from "@rynk/events";
import { ExposureRegistry } from "@rynk/exposure";
import { Logger } from "@rynk/logger";
import { listInterfaces, NetworkWatcher } from "@rynk/network";
import { MemoryPortStore, PortAllocator } from "@rynk/ports";
import { BuiltinProxy } from "@rynk/proxy";
import { RuntimeRegistry } from "@rynk/runtime";
import { createServer, DeploymentEngine, DeviceAgent, LogManager, PluginManager, Store } from "../src/index.js";
import { SecretBox } from "../src/secrets.js";

// A controllable network so tests can simulate switching Wi-Fi networks.
const fakeIface = (address: string) => ({ wlan0: [{ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:01", internal: false, cidr: `${address}/24` }] });
let currentNet = fakeIface("127.0.0.1");
import { fixture, freePort, NODE_SERVER, pkg } from "../../../tests/helpers/fixtures.js";

const TOKEN = "test-token-0123456789";
let stack: Awaited<ReturnType<typeof build>>;

async function build() {
  const bus = new EventBus();
  const logger = new Logger({ sinks: [] });
  const store = new Store(openDatabase(path.join(HOME, "rynk.db")), new SecretBox(HOME));
  const logs = new LogManager(store, bus, "rynk-node-test000000000000000000");
  const detectors = new DetectorRegistry();
  const runtimes = new RuntimeRegistry();
  const exposures = new ExposureRegistry();
  const plugins = new PluginManager({ detectors, runtimes, exposures }, logger);
  const ports = new PortAllocator(store.portStore(), [43000, 43999]);
  const appPorts = new PortAllocator(new MemoryPortStore(), [44000, 44999]);
  // 127.0.0.1 stands in for the LAN address so share links are reachable in CI.
  const network = new NetworkWatcher(bus, 60_000, () => listInterfaces(currentNet as never, {}).concat(currentNet.wlan0[0]!.address === "127.0.0.1" ? [{ name: "wlan0", address: "127.0.0.1", family: "IPv4", kind: "wifi", private: true, score: 100 }] : []), async () => ({}));
  const proxy = new BuiltinProxy(await freePort(), "127.0.0.1");
  await proxy.start();
  const device = new DeviceAgent(store, network);
  const engine = new DeploymentEngine({ store, bus, logs, detectors, runtimes, ports, appPorts, proxy, network, exposures, plugins, logger, nodeId: "rynk-node-test000000000000000000" });
  const app = await createServer({ token: TOKEN, engine, store, bus, logs, network, proxy, exposures, plugins, device, logger, startedAt: Date.now(), onShutdown: () => {} });
  return { bus, store, engine, proxy, app, logs, network };
}

const auth = { authorization: `Bearer ${TOKEN}`, host: "127.0.0.1:9876" };
const api = async <T = any>(method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = auth) => {
  const r = await stack.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: r.statusCode, body: (r.body ? JSON.parse(r.body) : null) as T };
};

const get = (port: number, p = "/") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });

beforeAll(async () => {
  stack = await build();
});
afterAll(async () => {
  await stack.engine.shutdown();
  await stack.app.close();
  await stack.proxy.stop();
  await stack.store.close();
});

describe("API security", () => {
  it("serves health without auth", async () => {
    expect((await api("GET", "/api/health", undefined, { host: "127.0.0.1:9876" })).status).toBe(200);
  });
  it("rejects missing or wrong tokens", async () => {
    expect((await api("GET", "/api/projects", undefined, { host: "127.0.0.1:9876" })).status).toBe(401);
    expect((await api("GET", "/api/projects", undefined, { host: "127.0.0.1:9876", authorization: "Bearer nope" })).status).toBe(401);
  });
  it("rejects non-loopback Host headers (DNS rebinding)", async () => {
    expect((await api("GET", "/api/projects", undefined, { ...auth, host: "attacker.example:9876" })).status).toBe(421);
  });
  it("rejects cross-origin browsers", async () => {
    expect((await api("GET", "/api/projects", undefined, { ...auth, origin: "http://evil.example" })).status).toBe(403);
  });
  it("validates input with friendly errors", async () => {
    const r = await api("POST", "/api/deployments", { root: "", port: 99999 });
    expect(r.status).toBe(400);
    expect(r.body.error.causes.length).toBeGreaterThan(0);
  });
});

describe("deployment lifecycle (real processes)", () => {
  const root = fixture({ "package.json": pkg({ name: "e2e-app", scripts: { start: "node server.js" } }), "server.js": NODE_SERVER });
  let projectId = "";
  let port = 0;

  it("detects, starts, health-checks and goes LIVE with URLs and a proxy route", async () => {
    const r = await api("POST", "/api/deployments", { root, install: false, wait: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    projectId = r.body.projectId;
    const d = r.body.deployment;
    expect(d.state).toBe("LIVE");
    expect(d.health).toBe("HEALTHY");
    port = d.port;
    expect(d.urls.local).toBe(`http://localhost:${port}`);
    expect(d.appPort).not.toBe(port); // the app listens on loopback; the gateway owns the share port
    expect((await get(port)).body).toBe(`hello from fixture ${d.appPort}`);
    expect((await get(stack.proxy.port, "/e2e-app/")).body).toBe(`hello from fixture ${d.appPort}`);
  });

  it("creates a hosting session with the share link, node and ports", async () => {
    const p = (await api("GET", `/api/projects/${projectId}`)).body;
    const hs = p.deployment.hostingSession;
    expect(hs).toMatchObject({ nodeId: "rynk-node-test000000000000000000", projectName: "e2e-app", sharePort: port, status: "live", exposure: "lan" });
    expect(hs.internalPort).toBe(p.deployment.appPort);
    expect(hs.shareUrl).toBe(p.deployment.urls.network);
    const listed = (await api("GET", `/api/hosting-sessions?projectId=${projectId}`)).body;
    expect(listed[0].id).toBe(hs.id);
  });

  it("tags log lines with node, hosting session and process", async () => {
    await api("PATCH", `/api/projects/${projectId}/access`, { maxUsers: 0 }); // writes a log line while hosting
    const hsId = (await api("GET", `/api/projects/${projectId}`)).body.deployment.hostingSession.id;
    const logs = (await api<Array<{ message: string; hostingSessionId?: string; pid?: number; nodeId?: string }>>("GET", `/api/projects/${projectId}/logs?limit=200`)).body;
    const appLine = logs.find((l) => l.message.includes("listening on"))!;
    expect(appLine.pid).toBeGreaterThan(0);
    expect(appLine.nodeId).toBe("rynk-node-test000000000000000000");
    const accessLine = logs.find((l) => l.message.startsWith("Access:"))!;
    expect(accessLine.hostingSessionId).toBe(hsId);
  });

  it("updates the share link when the network changes, without restarting the app", async () => {
    const before = (await api("GET", `/api/projects/${projectId}`)).body.deployment;
    const updated = stack.bus.once("urls.updated", (p) => p.projectId === projectId, 5000);
    currentNet = fakeIface("10.20.30.40");
    expect(stack.network.check()).toBe(true);
    const ev = await updated;
    expect(ev.urls.network).toBe(`http://10.20.30.40:${port}`);
    const after = (await api("GET", `/api/projects/${projectId}`)).body.deployment;
    expect(after.pid).toBe(before.pid);
    expect(after.hostingSession.shareUrl).toBe(`http://10.20.30.40:${port}`);
    currentNet = fakeIface("127.0.0.1");
    stack.network.check();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("records the pipeline in logs, in order", async () => {
    const logs = (await api<Array<{ message: string }>>("GET", `/api/projects/${projectId}/logs?limit=100`)).body.map((l) => l.message);
    const idx = (m: string) => logs.findIndex((l) => l.startsWith(m));
    expect(idx("Detecting project")).toBeLessThan(idx("Starting application"));
    expect(idx("Starting application")).toBeLessThan(idx("Waiting for the app to respond"));
    expect(logs.some((l) => l.includes("listening on"))).toBe(true);
  });

  it("returns the existing deployment instead of starting a duplicate", async () => {
    const r = await api("POST", "/api/deployments", { root });
    expect(r.body.existing).toBe(true);
  });

  it("tracks clients and enforces the user limit on the share link", async () => {
    // Earlier tests' requests still hold sessions; end them so we start from zero.
    for (const s of (await api("GET", `/api/projects/${projectId}/clients`)).body.sessions) {
      await api("POST", `/api/projects/${projectId}/clients/${s.sessionId}/disconnect`, {});
    }
    await api("PATCH", `/api/projects/${projectId}/access`, { maxUsers: 1 });
    const hit = (ua: string) => new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/", headers: { "user-agent": ua } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on("error", reject);
    });
    expect(await hit("first")).toBe(200);
    expect(await hit("second")).toBe(503);
    const v = (await api("GET", `/api/projects/${projectId}/clients`)).body;
    expect(v).toMatchObject({ active: 1, limit: 1, managed: true });
    expect(v.sessions[0]).toMatchObject({ clientAddress: "127.0.0.1", userAgent: "first", status: "active" });
    const kicked = await api("POST", `/api/projects/${projectId}/clients/${v.sessions[0].sessionId}/disconnect`, { block: false });
    expect(kicked.body.status).toBe("closed");
    expect(await hit("second")).toBe(200);
    await api("PATCH", `/api/projects/${projectId}/access`, { maxUsers: 0 });
  });

  it("creates invite links and switches to invite-only without locking out current users", async () => {
    const inv = (await api("POST", `/api/projects/${projectId}/invites`, { ttlMs: 60_000, maxUses: 1 })).body;
    expect(inv.url).toMatch(/\?rynk_access=/);
    const p = (await api("GET", `/api/projects/${projectId}`)).body;
    expect(p.deployment.access.mode).toBe("protected");
    expect((await api("DELETE", `/api/projects/${projectId}/invites/${inv.id}`)).body.ok).toBe(true);
    await api("PATCH", `/api/projects/${projectId}/access`, { mode: "open" });
  });

  it("restarts in place on request: same deployment, same share port", async () => {
    const before = (await api("GET", `/api/projects/${projectId}`)).body.deployment;
    const done = stack.bus.once("deployment.completed", (p) => p.projectId === projectId, 15_000);
    const r = await api("POST", `/api/projects/${projectId}/restart`, {});
    expect(r.body.inPlace).toBe(true);
    await done;
    const after = (await api("GET", `/api/projects/${projectId}`)).body.deployment;
    expect(after.id).toBe(before.id);
    expect(after.port).toBe(before.port);
    expect(after.pid).not.toBe(before.pid);
    expect((await get(port)).status).toBe(200);
  });

  it("restarts the app after a crash", async () => {
    const restarted = stack.bus.once("deployment.completed", (p) => p.projectId === projectId, 15_000);
    await get(port, "/crash").catch(() => undefined);
    await restarted;
    const p = (await api("GET", `/api/projects/${projectId}`)).body;
    expect(p.deployment.state).toBe("LIVE");
    expect(p.deployment.restartCount).toBe(2); // one requested restart + one crash restart
    expect((await get(port)).status).toBe(200);
  });

  it("stops cleanly and frees the port and route", async () => {
    const hsId = (await api("GET", `/api/projects/${projectId}`)).body.deployment.hostingSession.id;
    const r = await api("POST", `/api/projects/${projectId}/stop`, {});
    expect(r.body.state).toBe("STOPPED");
    const hs = (await api("GET", `/api/hosting-sessions?projectId=${projectId}`)).body.find((h: { id: string }) => h.id === hsId);
    expect(hs).toMatchObject({ status: "stopped" });
    expect(hs.endedAt).toBeGreaterThan(0);
    await expect(get(port)).rejects.toThrow();
    expect((await api<unknown[]>("GET", "/api/routes")).body).toHaveLength(0);
  });

  it("reuses the same port on the next start (sticky)", async () => {
    const r = await api("POST", "/api/deployments", { root, install: false, wait: true });
    try {
      expect(r.body.deployment.port).toBe(port);
    } finally {
      await api("POST", `/api/projects/${projectId}/stop`, {});
    }
  });
});

describe("failures are explained, never marked LIVE", () => {
  it("explains a startup crash with causes and suggestions", async () => {
    const root = fixture({ "package.json": pkg({ name: "crashy", scripts: { start: "node server.js" } }), "server.js": "require('definitely-missing-module')" });
    const r = await api("POST", "/api/deployments", { root, install: false, wait: true });
    expect(r.body.ok).toBe(false);
    expect(r.body.error.message).toMatch(/exited during startup/);
    expect(r.body.error.suggestions.join(" ")).toMatch(/rynk logs/);
  });

  it("fails when the app never answers on its port", async () => {
    const root = fixture({ "rynk.yaml": "name: silent\nstart:\n  command: node idle.js\nhealth:\n  startupTimeout: 2s\n", "idle.js": "setInterval(() => {}, 1000)" });
    const r = await api("POST", "/api/deployments", { root, wait: true });
    expect(r.body.ok).toBe(false);
    expect(r.body.error.code).toBe("HEALTH_CHECK_FAILED");
  });

  it("explains undetectable projects", async () => {
    const r = await api("POST", "/api/deployments", { root: fixture({ "notes.txt": "hi" }), wait: true });
    expect(r.body.ok).toBe(false);
    expect(r.body.error.code).toBe("DETECTION_FAILED");
  });

  it("404s unknown directories", async () => {
    const r = await api("POST", "/api/deployments", { root: path.join(HOME, "nope") });
    expect(r.status).toBe(404);
  });
});

describe("secrets at rest", () => {
  it("encrypts env values in the database and redacts them from the API", async () => {
    const root = fixture({ "package.json": pkg({ name: "secret-app", scripts: { start: "node server.js" } }), "server.js": NODE_SERVER });
    const r = await api("POST", "/api/deployments", { root, install: false, wait: true, env: { API_TOKEN: "tok_super_secret_value", GREETING: "hi" } });
    expect(r.body.ok).toBe(true);
    await stack.store.flushLogs();
    const raw = fs.readFileSync(path.join(HOME, "rynk.db")).toString("latin1") + (fs.existsSync(path.join(HOME, "rynk.db-wal")) ? fs.readFileSync(path.join(HOME, "rynk.db-wal")).toString("latin1") : "");
    expect(raw).not.toContain("tok_super_secret_value");
    const view = (await api("GET", `/api/projects/${r.body.projectId}`)).body;
    expect(view.definition.env).toEqual({ API_TOKEN: "[REDACTED]", GREETING: "hi" });
    // …but the app itself got the real value, and a restart still has it.
    const saved = await stack.store.getSetting<{ env: Record<string, string> }>(`request:${r.body.projectId}`);
    expect(saved?.env.API_TOKEN).toBe("tok_super_secret_value");
    await api("POST", `/api/projects/${r.body.projectId}/stop`, {});
  });
});

describe("static sites and detection API", () => {
  it("serves a static folder through the runtime and the proxy", async () => {
    const root = fixture({ "index.html": "<h1>static e2e</h1>", ".env": "SECRET=1" });
    const r = await api("POST", "/api/deployments", { root, name: "site", wait: true });
    expect(r.body.ok).toBe(true);
    expect((await get(r.body.deployment.port)).body).toContain("static e2e");
    expect((await get(stack.proxy.port, "/site/.env")).status).toBe(404);
    await api("POST", `/api/projects/${r.body.projectId}/stop`, {});
  });

  it("plans a project without running or reserving anything", async () => {
    const root = fixture({ "package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }), "pnpm-lock.yaml": "" });
    const r = await api("GET", `/api/plan?root=${encodeURIComponent(root)}&maxUsers=4`);
    expect(r.body.best.framework).toBe("Vite");
    expect(r.body.packageManager).toBe("pnpm");
    expect(r.body.sharePort).toBeGreaterThan(0);
    expect(r.body.project.access.maxUsers).toBe(4);
    expect((await api("GET", "/api/ports")).body.apps).toHaveLength(0);
  });

  it("reports network and this node even without discovery", async () => {
    const net = (await api("GET", "/api/network")).body;
    expect(net).toHaveProperty("interfaces");
    expect(net.discovery.enabled).toBe(false);
    expect(Array.isArray((await api("GET", "/api/apps")).body)).toBe(true);
  });
});
