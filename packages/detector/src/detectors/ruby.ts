import { cmd, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

export const rubyDetector: Detector = {
  name: "ruby",
  detect(ctx: ProjectContext): DetectionResult | null {
    const gemfile = ctx.read("Gemfile");
    const rack = ctx.exists("config.ru");
    if (gemfile === null && !rack) return null;
    const rails = ctx.exists("config/application.rb") || /gem ['"]rails['"]/.test(gemfile ?? "");
    const install = gemfile !== null ? [cmd("bundle", "install")] : undefined;
    if (rails) {
      return {
        detector: "ruby", language: "ruby", framework: "Rails", runtime: "native", confidence: 0.92,
        evidence: ["Gemfile", "rails"],
        start: ctx.exists("bin/rails") ? cmd("bin/rails", "server") : cmd("bundle", "exec", "rails", "server"),
        binding: { args: ["-b", "{host}", "-p", "{port}"], portControllable: true },
        defaultPort: 3000,
        ...(install ? { install } : {}),
      };
    }
    if (rack) {
      const sinatra = /sinatra/.test(gemfile ?? "");
      return {
        detector: "ruby", language: "ruby", runtime: "native", confidence: 0.8,
        ...(sinatra ? { framework: "Sinatra" } : {}),
        evidence: ["config.ru"],
        start: cmd("bundle", "exec", "rackup"),
        binding: { args: ["-o", "{host}", "-p", "{port}"], portControllable: true },
        defaultPort: 9292,
        ...(install ? { install } : {}),
      };
    }
    return { detector: "ruby", language: "ruby", runtime: "native", confidence: 0.3, evidence: ["Gemfile"], warnings: ["Ruby project without Rails or config.ru; set start.command in rynk.yaml."] };
  },
};
