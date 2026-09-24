import net from "node:net";
import { describe, expect, it } from "vitest";
import { isListening, isPortFree, parsePortFromOutput, PortAllocator } from "../src/index.js";

const fakeProbe = (busy: Set<number>) => async (p: number) => !busy.has(p);

describe("PortAllocator", () => {
  it("gives the preferred port when free", async () => {
    const a = new PortAllocator(undefined, [3000, 3100], fakeProbe(new Set()));
    expect(await a.allocate("p1", 3000)).toBe(3000);
  });
  it("never gives two projects the same port, even concurrently", async () => {
    const a = new PortAllocator(undefined, [3000, 3100], fakeProbe(new Set()));
    const ports = await Promise.all(["a", "b", "c", "d"].map((id) => a.allocate(id, 3000)));
    expect(new Set(ports).size).toBe(4);
    expect(ports).toContain(3000);
  });
  it("skips ports used by other programs", async () => {
    const a = new PortAllocator(undefined, [3000, 9999], fakeProbe(new Set([5173])));
    expect(await a.allocate("vite", 5173)).toBe(5174);
  });
  it("fails in strict mode instead of silently switching", async () => {
    const a = new PortAllocator(undefined, [3000, 3100], fakeProbe(new Set([8080])));
    await expect(a.allocate("x", 8080, true)).rejects.toThrow(/already in use/);
  });
  it("keeps sticky ports across restarts", async () => {
    const a = new PortAllocator(undefined, [3000, 3100], fakeProbe(new Set([3000])));
    const first = await a.allocate("app", 3000);
    a.release("app");
    expect(await a.allocate("app", 3000)).toBe(first);
  });
});

describe("OS port checks", () => {
  it("detects listening and busy ports", async () => {
    const server = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await isListening(port)).toBe(true);
    expect(await isPortFree(port)).toBe(false);
    server.close();
  });
});

describe("parsePortFromOutput", () => {
  it.each([
    ["  ➜  Local:   http://localhost:5173/", 5173],
    ["Listening on port 8080", 8080],
    ["INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)", 8000],
    ["\u001b[32mready\u001b[39m - started server on 0.0.0.0:3000, url: http://localhost:3000", 3000],
    ["Tomcat started on port 8081 (http)", 8081],
  ])("%s → %d", (line, port) => {
    expect(parsePortFromOutput(line)).toBe(port);
  });
  it("ignores unrelated numbers", () => {
    expect(parsePortFromOutput("compiled 1234 modules in 5678ms")).toBeUndefined();
  });
});
