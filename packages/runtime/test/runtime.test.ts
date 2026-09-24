import http from "node:http";
import { describe, expect, it } from "vitest";
import { backoffDelay, materialize, NativeRuntime, StaticRuntime } from "../src/index.js";
import { definition, fixture, freePort, NODE_SERVER } from "../../../tests/helpers/fixtures.js";

const fetchText = (port: number, path = "/") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });

async function until(fn: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

describe("materialize", () => {
  it("injects port/host via env and args templates", () => {
    const p = definition("/x", { start: { file: "vite", args: [], display: "vite" }, binding: { env: { PORT: "{port}" }, args: ["--port", "{port}", "--host", "{host}"], portControllable: true } });
    const { command, env } = materialize(p, { port: 5173, host: "0.0.0.0" });
    expect(command.args).toEqual(["--port", "5173", "--host", "0.0.0.0"]);
    expect(env.PORT).toBe("5173");
  });
});

describe("NativeRuntime", () => {
  it("starts a real server on the given port, captures output and stops the tree", async () => {
    const root = fixture({ "server.js": NODE_SERVER });
    const port = await freePort();
    const lines: string[] = [];
    const inst = await new NativeRuntime().start(definition(root), { port, host: "127.0.0.1", origin: "detector", onLine: (l) => lines.push(l) });
    await until(async () => (await fetchText(port)).status === 200);
    expect((await fetchText(port)).body).toBe(`hello from fixture ${port}`);
    expect(lines.join("\n")).toContain(`listening on http://localhost:${port}`);
    await inst.stop(2000);
    expect(inst.alive()).toBe(false);
    await expect(fetchText(port)).rejects.toThrow();
  });
  it("reports the exit code of a crashing app", async () => {
    const root = fixture({ "server.js": "process.exit(7)" });
    const inst = await new NativeRuntime().start(definition(root), { port: await freePort(), host: "127.0.0.1", origin: "detector", onLine: () => {} });
    expect((await inst.exited).code).toBe(7);
  });
});

describe("StaticRuntime", () => {
  it("serves files, falls back to index.html and hides secrets", async () => {
    const root = fixture({ "index.html": "<h1>home</h1>", "app.js": "console.log(1)", ".env": "SECRET=1" });
    const port = await freePort();
    const inst = await new StaticRuntime().start(definition(root, { runtime: "static", staticDir: root }), { port, host: "127.0.0.1", origin: "detector", onLine: () => {} });
    try {
      await until(async () => (await fetchText(port)).status === 200);
      expect((await fetchText(port, "/app.js")).body).toContain("console.log");
      expect((await fetchText(port, "/some/client/route")).body).toContain("home");
      expect((await fetchText(port, "/.env")).status).toBe(404);
      expect((await fetchText(port, "/../../etc/passwd")).body).not.toContain("root:");
    } finally {
      await inst.stop(1000);
    }
  });
});

describe("backoff", () => {
  it("grows exponentially and respects the cap", () => {
    const d1 = backoffDelay(1, 1000, 30_000);
    const d5 = backoffDelay(5, 1000, 30_000);
    expect(d1).toBeGreaterThanOrEqual(500);
    expect(d1).toBeLessThanOrEqual(1500);
    expect(d5).toBeGreaterThan(d1);
    expect(backoffDelay(20, 1000, 30_000)).toBeLessThanOrEqual(30_000);
  });
});
