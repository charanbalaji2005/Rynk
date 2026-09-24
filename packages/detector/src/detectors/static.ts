import type { DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

export const staticDetector: Detector = {
  name: "static",
  detect(ctx: ProjectContext): DetectionResult | null {
    const dir = ["", "public", "dist", "build", "site", "_site", "out"].find((d) => ctx.exists(d ? `${d}/index.html` : "index.html"));
    if (dir === undefined) return null;
    return {
      detector: "static",
      language: "html",
      framework: "Static site",
      runtime: "static",
      confidence: dir === "" ? 0.5 : 0.4,
      evidence: [`${dir ? dir + "/" : ""}index.html`],
      staticDir: ctx.path(dir),
      binding: { portControllable: true },
      defaultPort: 8080,
    };
  },
};
