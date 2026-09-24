import { cmd, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

export const dotnetDetector: Detector = {
  name: "dotnet",
  detect(ctx: ProjectContext): DetectionResult | null {
    const proj = ctx.findFile(/\.(csproj|fsproj|vbproj)$/);
    if (!proj) return null;
    const text = ctx.read(proj) ?? "";
    const web = /Microsoft\.NET\.Sdk\.Web/.test(text);
    return {
      detector: "dotnet",
      language: proj.endsWith(".fsproj") ? "fsharp" : "csharp",
      runtime: "native",
      confidence: web ? 0.9 : 0.6,
      evidence: [proj, ...(web ? ["Microsoft.NET.Sdk.Web"] : [])],
      ...(web ? { framework: "ASP.NET Core" } : {}),
      start: cmd("dotnet", "run", "--project", proj),
      binding: { env: { ASPNETCORE_URLS: "http://{host}:{port}", DOTNET_ENVIRONMENT: "Development" }, portControllable: true },
      defaultPort: 5000,
      ...(web ? {} : { warnings: ["Not an ASP.NET web project; it may not serve HTTP."] }),
    };
  },
};
