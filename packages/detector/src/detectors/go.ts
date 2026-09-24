import { cmd, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

const FRAMEWORKS: Array<[RegExp, string]> = [
  [/github\.com\/gin-gonic\/gin/, "Gin"],
  [/github\.com\/labstack\/echo/, "Echo"],
  [/github\.com\/gofiber\/fiber/, "Fiber"],
  [/github\.com\/go-chi\/chi/, "Chi"],
];

export const goDetector: Detector = {
  name: "go",
  detect(ctx: ProjectContext): DetectionResult | null {
    const mod = ctx.read("go.mod");
    if (mod === null) return null;
    const framework = FRAMEWORKS.find(([re]) => re.test(mod))?.[1];
    return {
      detector: "go",
      language: "go",
      runtime: "native",
      confidence: 0.85,
      evidence: ["go.mod", ...(framework ? [`framework: ${framework}`] : [])],
      start: ctx.isDir("cmd") && !ctx.exists("main.go") ? cmd("go", "run", "./...") : cmd("go", "run", "."),
      binding: { env: { PORT: "{port}", HOST: "{host}", GIN_MODE: "debug" }, portControllable: false },
      defaultPort: 8080,
      install: [cmd("go", "mod", "download")],
      ...(framework ? { framework } : {}),
    };
  },
};
