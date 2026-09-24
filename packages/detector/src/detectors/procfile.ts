import { tokenize, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

/** Heroku-style Procfile: `web: gunicorn app:app --bind 0.0.0.0:$PORT` */
export const procfileDetector: Detector = {
  name: "procfile",
  detect(ctx: ProjectContext): DetectionResult | null {
    const text = ctx.read("Procfile");
    if (text === null) return null;
    const line = text.split(/\r?\n/).find((l) => /^web\s*:/.test(l));
    if (!line) return null;
    const raw = line.replace(/^web\s*:\s*/, "").replace(/\$\{?PORT\}?/g, "{port}");
    let argv: string[];
    try {
      argv = tokenize(raw);
    } catch {
      return null;
    }
    if (/[|;&<>`]/.test(raw) || !argv.length) {
      return { detector: "procfile", language: "custom", runtime: "custom", confidence: 0.2, evidence: ["Procfile"], warnings: ["Procfile web command uses shell syntax; copy it into rynk.yaml with `shell: true`."] };
    }
    return {
      detector: "procfile",
      language: "custom",
      runtime: "custom",
      confidence: 0.78,
      evidence: ["Procfile (web)"],
      start: { file: argv[0]!, args: argv.slice(1), display: raw },
      binding: { env: { PORT: "{port}" }, portControllable: true },
    };
  },
};
