import { cmd, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

export const denoDetector: Detector = {
  name: "deno",
  detect(ctx: ProjectContext): DetectionResult | null {
    const cfg = ctx.json<{ tasks?: Record<string, string> }>("deno.json") ?? ctx.json("deno.jsonc");
    if (!cfg) return null;
    const task = ["dev", "start", "serve"].find((t) => cfg.tasks?.[t]);
    return {
      detector: "deno", language: "deno", runtime: "native", confidence: task ? 0.88 : 0.4,
      evidence: ["deno.json", ...(task ? [`task: ${task}`] : [])],
      ...(task ? { start: cmd("deno", "task", task) } : {}),
      binding: { env: { PORT: "{port}", HOST: "{host}" }, portControllable: false },
      defaultPort: 8000,
    };
  },
};
