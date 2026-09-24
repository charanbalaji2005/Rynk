import { cmd, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

export const rustDetector: Detector = {
  name: "rust",
  detect(ctx: ProjectContext): DetectionResult | null {
    const cargo = ctx.read("Cargo.toml");
    if (cargo === null) return null;
    const framework = /\baxum\b/.test(cargo) ? "Axum" : /actix-web/.test(cargo) ? "Actix Web" : /\brocket\b/.test(cargo) ? "Rocket" : /\bwarp\b/.test(cargo) ? "Warp" : undefined;
    const isRocket = framework === "Rocket";
    return {
      detector: "rust",
      language: "rust",
      runtime: "native",
      confidence: 0.85,
      evidence: ["Cargo.toml", ...(framework ? [`framework: ${framework}`] : [])],
      start: cmd("cargo", "run"),
      binding: isRocket
        ? { env: { ROCKET_ADDRESS: "{host}", ROCKET_PORT: "{port}" }, portControllable: true }
        : { env: { PORT: "{port}", HOST: "{host}" }, portControllable: false },
      defaultPort: isRocket ? 8000 : 8080,
      ...(framework ? { framework } : {}),
    };
  },
};
