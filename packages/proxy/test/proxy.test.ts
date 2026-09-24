import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BuiltinProxy } from "../src/index.js";
import { freePort } from "../../../tests/helpers/fixtures.js";

let app: http.Server;
let appPort: number;
let proxy: BuiltinProxy;

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).on("error", reject);
  });
}

beforeAll(async () => {
  app = http.createServer((req, res) => {
    if (req.url === "/go") { res.statusCode = 302; res.setHeader("location", "/dest"); return res.end(); }
    res.end(`path=${req.url} prefix=${req.headers["x-forwarded-prefix"] ?? ""}`);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => app.once("listening", r));
  appPort = (app.address() as { port: number }).port;
  proxy = new BuiltinProxy(await freePort(), "127.0.0.1");
  await proxy.start();
  await proxy.register({ id: "r1", projectId: "p1", name: "shop", pathPrefix: "/shop", hostnames: ["shop.localhost"], targetHost: "127.0.0.1", targetPort: appPort, lan: true });
});
afterAll(async () => { await proxy.stop(); app.close(); });

describe("BuiltinProxy", () => {
  it("routes by path prefix and strips it", async () => {
    const r = await get(proxy.port, "/shop/cart?x=1");
    expect(r.body).toBe("path=/cart?x=1 prefix=/shop");
  });
  it("routes by hostname", async () => {
    const r = await get(proxy.port, "/about", { host: "shop.localhost" });
    expect(r.body).toContain("path=/about");
  });
  it("rewrites redirects back under the prefix", async () => {
    const r = await get(proxy.port, "/shop/go");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/shop/dest");
  });
  it("finds absolute asset paths through the Referer", async () => {
    const r = await get(proxy.port, "/assets/app.js", { referer: `http://127.0.0.1:${proxy.port}/shop/` });
    expect(r.body).toContain("path=/assets/app.js");
  });
  it("blocks sensitive files", async () => {
    expect((await get(proxy.port, "/shop/.env")).status).toBe(404);
    expect((await get(proxy.port, "/shop/.git/config")).status).toBe(404);
  });
  it("404s unknown routes and forgets removed ones", async () => {
    expect((await get(proxy.port, "/nope/")).status).toBe(404);
    await proxy.remove("r1");
    expect((await get(proxy.port, "/shop/")).status).toBe(404);
    await proxy.register({ id: "r1", projectId: "p1", name: "shop", pathPrefix: "/shop", hostnames: ["shop.localhost"], targetHost: "127.0.0.1", targetPort: appPort, lan: true });
  });
});
