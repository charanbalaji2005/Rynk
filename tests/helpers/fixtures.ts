import type { ProjectDefinition } from "@rynk/core";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create a temporary project directory from a { relativePath: contents } map. */
export function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rynk-fx-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

export const pkg = (o: Record<string, unknown>) => JSON.stringify({ name: "fx", version: "1.0.0", ...o });

/** A zero-dependency HTTP server honouring PORT/HOST (used by runtime and e2e tests). */
export const NODE_SERVER = `
const http = require("node:http");
const port = Number(process.env.PORT) || 3000;
http.createServer((req, res) => {
  if (req.url === "/crash") { res.end("bye"); setTimeout(() => process.exit(3), 10); return; }
  res.setHeader("content-type", "text/plain");
  res.end("hello from fixture " + port);
}).listen(port, process.env.HOST || "0.0.0.0", () => console.log("listening on http://localhost:" + port));
`;


export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Minimal hand-built project definition for runtime tests. */
export function definition(root: string, over: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return {
    id: "prj_test",
    name: "test",
    root,
    runtime: "native",
    language: "node",
    start: { file: "node", args: ["server.js"], display: "node server.js" },
    env: {},
    host: "127.0.0.1",
    binding: { env: { PORT: "{port}", HOST: "{host}" }, portControllable: true },
    health: { type: "http", path: "/", intervalMs: 1000, timeoutMs: 1000, startupTimeoutMs: 15_000 },
    restart: { policy: "on-failure", maxRetries: 2, initialBackoffMs: 100, maxBackoffMs: 500 },
    exposure: "local",
    source: ["defaults"],
    ...over,
  } as ProjectDefinition;
}
