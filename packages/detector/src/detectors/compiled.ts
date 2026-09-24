import { cmd, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

/**
 * C / C++ / Zig. Build systems are recognised, but Rynk will not guess the
 * name of your server binary — that would be a dangerous guess.
 */
export const compiledDetector: Detector = {
  name: "compiled",
  detect(ctx: ProjectContext): DetectionResult | null {
    if (ctx.exists("build.zig")) {
      return { detector: "compiled", language: "zig", runtime: "native", confidence: 0.7, evidence: ["build.zig"], start: cmd("zig", "build", "run"), binding: { env: { PORT: "{port}" }, portControllable: false }, defaultPort: 8080 };
    }
    if (ctx.exists("CMakeLists.txt")) {
      return {
        detector: "compiled", language: "c/c++", runtime: "native", confidence: 0.3, evidence: ["CMakeLists.txt"],
        build: [cmd("cmake", "-S", ".", "-B", "build"), cmd("cmake", "--build", "build")],
        warnings: ["CMake project: set start.command in rynk.yaml, e.g. ./build/server"],
      };
    }
    if (ctx.exists("Makefile") && !ctx.exists("package.json")) {
      return { detector: "compiled", language: "c/c++", runtime: "native", confidence: 0.2, evidence: ["Makefile"], build: [cmd("make")], warnings: ["Makefile project: set start.command in rynk.yaml."] };
    }
    return null;
  },
};
