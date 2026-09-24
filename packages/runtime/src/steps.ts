import { RynkError, type CommandSpec, type ProjectDefinition } from "@rynk/core";
import { runStep } from "@rynk/process";
import { sanitizeEnv, validateCommand } from "@rynk/security";
import type { RuntimeContext } from "./types.js";

/** Run install/build steps sequentially; any failure aborts with a friendly error. */
export async function runSteps(kind: "install" | "build", steps: CommandSpec[] | undefined, project: ProjectDefinition, ctx: RuntimeContext): Promise<void> {
  for (const step of steps ?? []) {
    validateCommand(step, project.root, { origin: ctx.origin });
    ctx.onLine(`$ ${step.display}`, "system");
    const env = sanitizeEnv(process.env, { ...project.env, CI: "1", npm_config_yes: "true" });
    const r = await runStep(step, { cwd: project.root, env, onLine: ctx.onLine, ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: 20 * 60_000 });
    if (r.code !== 0) {
      const notFound = r.code === 127 || /ENOENT|not found|is not recognized/i.test(r.tail.join("\n"));
      throw new RynkError(kind === "install" ? "INSTALL_FAILED" : "BUILD_FAILED", `${kind === "install" ? "Installing dependencies" : "Building"} failed (${step.display}).`, {
        causes: notFound ? [`\`${step.file}\` is not installed or not on PATH.`] : r.tail.slice(-8),
        suggestions: notFound ? ["rynk doctor"] : ["rynk logs", `Run \`${step.display}\` yourself to see the full error.`],
        details: { exitCode: r.code },
      });
    }
  }
}
