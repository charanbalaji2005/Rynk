import path from "node:path";
import fs from "node:fs";
import { packageManagerOf, RynkError, type DetectionResult } from "@rynk/core";
import { ProjectContext } from "./context.js";
import type { Detector } from "./detector.js";
import { nodeDetector } from "./detectors/node.js";
import { pythonDetector } from "./detectors/python.js";
import { goDetector } from "./detectors/go.js";
import { rustDetector } from "./detectors/rust.js";
import { javaDetector } from "./detectors/java.js";
import { phpDetector } from "./detectors/php.js";
import { rubyDetector } from "./detectors/ruby.js";
import { dotnetDetector } from "./detectors/dotnet.js";
import { denoDetector } from "./detectors/deno.js";
import { dockerDetector, composeDetector } from "./detectors/docker.js";
import { procfileDetector } from "./detectors/procfile.js";
import { staticDetector } from "./detectors/static.js";
import { compiledDetector } from "./detectors/compiled.js";

export const BUILTIN_DETECTORS: Detector[] = [
  nodeDetector, pythonDetector, goDetector, rustDetector, javaDetector, phpDetector, rubyDetector,
  dotnetDetector, denoDetector, dockerDetector, composeDetector, procfileDetector, staticDetector, compiledDetector,
];

export interface DetectionReport {
  best: DetectionResult | null;
  candidates: DetectionResult[];
  ambiguous: boolean;
}

const LOCKFILES: Array<[string, string, string]> = [
  ["package-lock.json", "npm", "node"], ["pnpm-lock.yaml", "pnpm", "node"], ["yarn.lock", "yarn", "node"], ["bun.lock", "bun", "node"], ["bun.lockb", "bun", "node"],
  ["uv.lock", "uv", "python"], ["poetry.lock", "poetry", "python"], ["Pipfile.lock", "pipenv", "python"],
];

/** Registry of detectors; plugins register extra detectors at startup. */
export class DetectorRegistry {
  private detectors = new Map<string, Detector>();

  constructor(detectors: Detector[] = BUILTIN_DETECTORS) {
    for (const d of detectors) this.register(d);
  }

  register(d: Detector): void {
    this.detectors.set(d.name, d);
  }

  list(): string[] {
    return [...this.detectors.keys()];
  }

  async detect(root: string, opts: { prefer?: DetectionResult["runtime"] } = {}): Promise<DetectionReport> {
    const abs = path.resolve(root);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new RynkError("NOT_FOUND", `Project directory not found: ${abs}`);
    }
    const ctx = new ProjectContext(abs);
    const results: DetectionResult[] = [];
    for (const d of this.detectors.values()) {
      try {
        const r = await d.detect(ctx);
        if (r) results.push(r);
      } catch (e) {
        results.push({ detector: d.name, language: "unknown", runtime: "native", confidence: 0, evidence: [], warnings: [`Detector ${d.name} failed: ${(e as Error).message}`] });
      }
    }
    // Package manager on every result, and loud warnings when lockfiles disagree.
    const lockfiles = LOCKFILES.filter(([f]) => ctx.exists(f));
    const conflicts = (group: string) => lockfiles.filter(([, , g]) => g === group);
    for (const r of results) {
      r.packageManager ??= packageManagerOf({ ...(r.install ? { install: r.install } : {}), ...(r.start ? { start: r.start } : {}) });
      const group = r.language === "node" ? "node" : r.language === "python" ? "python" : undefined;
      if (group && conflicts(group).length > 1) {
        const names = conflicts(group).map(([f]) => f);
        r.warnings = [...(r.warnings ?? []), `Several lockfiles found (${names.join(", ")}). Using ${r.packageManager ?? "the declared manager"}; delete the others to avoid mismatched installs.`];
      }
      for (const [f] of lockfiles) if (!r.evidence.includes(f) && (group ? conflicts(group).some(([x]) => x === f) : false)) r.evidence.push(`lockfile: ${f}`);
    }
    let candidates = results.filter((r) => r.confidence > 0).sort((a, b) => b.confidence - a.confidence);
    if (opts.prefer) {
      const preferred = candidates.filter((c) => c.runtime === opts.prefer);
      if (preferred.length) candidates = [...preferred, ...candidates.filter((c) => c.runtime !== opts.prefer)];
    }
    const best = candidates[0] ?? null;
    const second = candidates[1];
    const ambiguous = Boolean(best && second && best.runtime === second.runtime && best.confidence - second.confidence < 0.05 && best.language !== second.language);
    if (best && ambiguous) {
      best.warnings = [...(best.warnings ?? []), `Also looks like ${second!.language}${second!.framework ? ` (${second!.framework})` : ""}. Set runtime in rynk.yaml to be explicit.`];
    }
    return { best, candidates, ambiguous };
  }
}
