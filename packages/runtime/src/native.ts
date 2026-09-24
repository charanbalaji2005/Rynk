import { interpolate, RynkError, withArgs, type CommandSpec, type ProjectDefinition } from "@rynk/core";
import { processStats, spawnManaged, toolVersion, which } from "@rynk/process";
import { defaultRedactor, sanitizeEnv, validateCommand } from "@rynk/security";
import { runSteps } from "./steps.js";
import type { Availability, RuntimeAdapter, RuntimeContext, RuntimeInstance } from "./types.js";

/** Materialize the final argv + env with port/host injected via the binding strategy. */
export function materialize(project: ProjectDefinition, ctx: Pick<RuntimeContext, "port" | "host">): { command: CommandSpec; env: Record<string, string> } {
  const vars = { port: ctx.port, host: ctx.host };
  const b = project.binding;
  const base: CommandSpec = project.start.shell
    ? { ...project.start, file: interpolate(project.start.file, vars) }
    : { ...project.start, args: project.start.args.map((a) => interpolate(a, vars)) };
  const extra = (b.args ?? []).map((a) => interpolate(a, vars));
  const command = extra.length ? withArgs(base, extra) : { ...base, display: base.shell ? base.file : [base.file, ...base.args].join(" ") };
  const bindEnv = Object.fromEntries(Object.entries(b.env ?? {}).map(([k, v]) => [k, interpolate(v, vars)]));
  const env = sanitizeEnv(process.env, {
    BROWSER: "none", // stop dev servers opening browser tabs
    ...bindEnv,
    ...project.env, // user env wins over injected defaults
  });
  return { command, env };
}

export class NativeRuntime implements RuntimeAdapter {
  readonly kind: "native" | "custom" = "native";

  async available(project?: ProjectDefinition): Promise<Availability> {
    if (!project || project.start.shell) return { ok: true };
    const bin = project.start.file;
    if (bin.includes("/") || bin.includes("\\")) return { ok: true };
    if (!which(bin)) {
      return { ok: false, reason: `\`${bin}\` is not installed or not on your PATH.` };
    }
    const version = await toolVersion(bin);
    return { ok: true, ...(version ? { version } : {}) };
  }

  install(project: ProjectDefinition, ctx: RuntimeContext) {
    return runSteps("install", project.install, project, ctx);
  }

  build(project: ProjectDefinition, ctx: RuntimeContext) {
    return runSteps("build", project.build, project, ctx);
  }

  async start(project: ProjectDefinition, ctx: RuntimeContext): Promise<RuntimeInstance> {
    const { command, env } = materialize(project, ctx);
    validateCommand(command, project.root, { origin: ctx.origin });
    defaultRedactor.addFromEnv(env);
    ctx.onLine(`$ ${command.display}`, "system");
    const proc = spawnManaged(command, { cwd: project.root, env, onLine: ctx.onLine });
    if (proc.pid === undefined) {
      const exit = await proc.exited;
      throw new RynkError("START_FAILED", `Could not start \`${command.display}\`.`, {
        causes: [`\`${command.file}\` may not be installed.`],
        suggestions: ["rynk doctor"],
        details: { exit },
      });
    }
    const kind = this.kind;
    return {
      kind,
      pid: proc.pid,
      startedAt: proc.startedAt,
      command,
      alive: () => proc.alive,
      exited: proc.exited,
      stop: async (grace?: number) => void (await proc.kill(grace)),
      stats: () => processStats(proc.pid!),
    };
  }
}

/** Arbitrary user command. Same mechanics as native; distinct for reporting. */
export class CustomRuntime extends NativeRuntime {
  override readonly kind = "custom" as const;
}
