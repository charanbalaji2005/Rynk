import { cmd, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

export const phpDetector: Detector = {
  name: "php",
  detect(ctx: ProjectContext): DetectionResult | null {
    const composer = ctx.exists("composer.json");
    const artisan = ctx.exists("artisan");
    const index = ctx.exists("index.php") || ctx.exists("public/index.php");
    if (!composer && !artisan && !index) return null;
    const install = composer && !ctx.isDir("vendor") ? [cmd("composer", "install")] : undefined;
    if (artisan) {
      return {
        detector: "php", language: "php", framework: "Laravel", runtime: "native", confidence: 0.92,
        evidence: ["artisan", ...(composer ? ["composer.json"] : [])],
        start: cmd("php", "artisan", "serve"),
        binding: { args: ["--host={host}", "--port={port}"], portControllable: true },
        defaultPort: 8000,
        ...(install ? { install } : {}),
      };
    }
    const docroot = ctx.exists("public/index.php") ? "public" : ".";
    return {
      detector: "php", language: "php", runtime: "native", confidence: index ? 0.75 : 0.4,
      evidence: [composer ? "composer.json" : "index.php", `document root: ${docroot}`],
      start: cmd("php", "-S", "{host}:{port}", "-t", docroot),
      binding: { portControllable: true },
      defaultPort: 8000,
      ...(install ? { install } : {}),
    };
  },
};
