import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { RynkError, cmd, type ProjectDefinition } from "@rynk/core";
import { processStats, spawnManaged } from "@rynk/process";
import { sanitizeEnv } from "@rynk/security";
import { runSteps } from "./steps.js";
import type { Availability, RuntimeAdapter, RuntimeContext, RuntimeInstance } from "./types.js";

// Next to this file in dist/; when running from source (tests), use the built copy.
const SERVER = [new URL("./static-server.js", import.meta.url), new URL("../dist/static-server.js", import.meta.url)]
  .map((u) => fileURLToPath(u))
  .find((f) => fs.existsSync(f)) ?? fileURLToPath(new URL("./static-server.js", import.meta.url));

/** Serves a directory with Rynk's hardened static server as a supervised child process. */
export class StaticRuntime implements RuntimeAdapter {
  readonly kind = "static" as const;
  async available(): Promise<Availability> {
    return { ok: true, version: process.versions.node };
  }
  install(p: ProjectDefinition, ctx: RuntimeContext) {
    return runSteps("install", p.install, p, ctx);
  }
  build(p: ProjectDefinition, ctx: RuntimeContext) {
    return runSteps("build", p.build, p, ctx);
  }
  async start(p: ProjectDefinition, ctx: RuntimeContext): Promise<RuntimeInstance> {
    const dir = p.staticDir ?? p.root;
    if (!dir) throw new RynkError("START_FAILED", "No static directory configured.");
    const command = cmd(process.execPath, SERVER, dir, String(ctx.port), ctx.host);
    ctx.onLine(`$ rynk static ${dir}`, "system");
    const proc = spawnManaged(command, { cwd: p.root, env: sanitizeEnv(process.env), onLine: ctx.onLine });
    return {
      kind: "static",
      ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
      startedAt: proc.startedAt,
      command: { ...command, display: `static ${dir}` },
      alive: () => proc.alive,
      exited: proc.exited,
      stop: async (g?: number) => void (await proc.kill(g)),
      stats: () => (proc.pid ? processStats(proc.pid) : Promise.resolve(null)),
    };
  }
}
