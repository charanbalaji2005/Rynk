import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HealthMonitor, httpProbe, tcpProbe, waitForHealthy } from "../src/index.js";

let server: http.Server;
let port: number;
let status = 200;
beforeAll(async () => {
  server = http.createServer((_q, s) => { s.statusCode = status; s.end("ok"); }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

const spec = { type: "http" as const, path: "/", intervalMs: 50, timeoutMs: 500, startupTimeoutMs: 3000 };

describe("probes", () => {
  it("http probe succeeds against a real server", async () => {
    const r = await httpProbe("127.0.0.1", port);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });
  it("treats 4xx as alive (the server answered) and 5xx as unhealthy", async () => {
    status = 404;
    expect((await httpProbe("127.0.0.1", port)).ok).toBe(true);
    status = 503;
    expect((await httpProbe("127.0.0.1", port)).ok).toBe(false);
    status = 200;
  });
  it("tcp probe fails on a closed port", async () => {
    expect((await tcpProbe("127.0.0.1", 1, 300)).ok).toBe(false);
  });
});

describe("waitForHealthy", () => {
  it("resolves once the app answers", async () => {
    const r = await waitForHealthy(spec, { host: "127.0.0.1", port, isAlive: () => true });
    expect(r.ok).toBe(true);
  });
  it("gives up quickly when the process died", async () => {
    const t = Date.now();
    const r = await waitForHealthy(spec, { host: "127.0.0.1", port: 1, isAlive: () => false });
    expect(r.ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("HealthMonitor", () => {
  it("reports UNHEALTHY only after consecutive failures", async () => {
    const changes: string[] = [];
    const m = new HealthMonitor(spec, () => ({ host: "127.0.0.1", port, isAlive: () => true }), (_f, to) => changes.push(to));
    m.status = "HEALTHY";
    status = 500;
    m.start();
    await new Promise((r) => setTimeout(r, 600));
    m.stop();
    status = 200;
    expect(changes).toContain("UNHEALTHY");
  });
});
