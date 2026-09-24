import { cmd, type BindingStrategy, type CommandSpec, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

interface PackageJson {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

type PM = "npm" | "pnpm" | "yarn" | "bun";

function packageManager(ctx: ProjectContext, pkg: PackageJson): PM {
  const declared = pkg.packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  if (ctx.exists("pnpm-lock.yaml")) return "pnpm";
  if (ctx.exists("bun.lockb") || ctx.exists("bun.lock")) return "bun";
  if (ctx.exists("yarn.lock")) return "yarn";
  return "npm";
}

interface Framework {
  id: string;
  label: string;
  deps: string[];
  /** Binary names that must appear in the script for flag injection to be safe. */
  bins: string[];
  port: number;
  args?: string[];
  env?: Record<string, string>;
}

// Order matters: meta-frameworks before the bundlers they're built on.
const FRAMEWORKS: Framework[] = [
  { id: "nextjs", label: "Next.js", deps: ["next"], bins: ["next"], port: 3000, args: ["-H", "{host}", "-p", "{port}"] },
  { id: "nuxt", label: "Nuxt", deps: ["nuxt"], bins: ["nuxt", "nuxi"], port: 3000, args: ["--host", "{host}", "--port", "{port}"] },
  { id: "remix", label: "Remix", deps: ["@remix-run/dev"], bins: ["vite", "remix vite:dev"], port: 5173, args: ["--host", "{host}", "--port", "{port}", "--strictPort"] },
  { id: "sveltekit", label: "SvelteKit", deps: ["@sveltejs/kit"], bins: ["vite"], port: 5173, args: ["--host", "{host}", "--port", "{port}", "--strictPort"] },
  { id: "astro", label: "Astro", deps: ["astro"], bins: ["astro"], port: 4321, args: ["--host", "{host}", "--port", "{port}"] },
  { id: "angular", label: "Angular", deps: ["@angular/cli"], bins: ["ng"], port: 4200, args: ["--host", "{host}", "--port", "{port}"] },
  { id: "gatsby", label: "Gatsby", deps: ["gatsby"], bins: ["gatsby"], port: 8000, args: ["-H", "{host}", "-p", "{port}"] },
  { id: "cra", label: "Create React App", deps: ["react-scripts"], bins: ["react-scripts"], port: 3000, env: { PORT: "{port}", HOST: "{host}", BROWSER: "none" } },
  { id: "vite", label: "Vite", deps: ["vite"], bins: ["vite"], port: 5173, args: ["--host", "{host}", "--port", "{port}", "--strictPort"] },
  { id: "nestjs", label: "NestJS", deps: ["@nestjs/core"], bins: [], port: 3000 },
  { id: "express", label: "Express", deps: ["express"], bins: [], port: 3000 },
  { id: "fastify", label: "Fastify", deps: ["fastify"], bins: [], port: 3000 },
  { id: "koa", label: "Koa", deps: ["koa"], bins: [], port: 3000 },
  { id: "hono", label: "Hono", deps: ["hono"], bins: [], port: 3000 },
];

const UI_LIBS: Array<[string, string]> = [["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"], ["solid-js", "Solid"], ["preact", "Preact"], ["lit", "Lit"]];

function runScript(pm: PM, script: string, extra: string[]): CommandSpec {
  // npm needs `--` to forward flags; pnpm/yarn/bun forward them directly.
  if (pm === "npm") return cmd("npm", "run", script, ...(extra.length ? ["--", ...extra] : []));
  return cmd(pm, "run", script, ...extra);
}

export const nodeDetector: Detector = {
  name: "node",
  detect(ctx: ProjectContext): DetectionResult | null {
    const pkg = ctx.json<PackageJson>("package.json");
    if (!pkg) return null;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const pm = packageManager(ctx, pkg);
    const evidence = ["package.json", `package manager: ${pm}`];
    const warnings: string[] = [];

    const fw = FRAMEWORKS.find((f) => f.deps.some((d) => d in deps));
    const ui = UI_LIBS.find(([d]) => d in deps)?.[1];
    if (fw) evidence.push(`dependency: ${fw.deps.find((d) => d in deps)}`);

    const scripts = pkg.scripts ?? {};
    const scriptName = ["dev", "start", "serve", "preview"].find((s) => scripts[s]);
    let start: CommandSpec | undefined;
    let binding: BindingStrategy = { env: { PORT: "{port}", HOST: "{host}" }, portControllable: false };

    if (scriptName) {
      const body = scripts[scriptName]!;
      evidence.push(`script "${scriptName}": ${body}`);
      const invokesFramework = fw && fw.bins.some((b) => new RegExp(`(^|[\\s&;/])${b.replace(/ /g, "\\s+")}(\\s|$)`).test(body));
      if (fw && invokesFramework && fw.args) {
        // We can't append forwarded args into the script itself, so the runtime appends them.
        start = runScript(pm, scriptName, []);
        binding = {
          env: { PORT: "{port}", HOST: "{host}", ...(fw.env ?? {}) },
          args: pm === "npm" ? ["--", ...fw.args] : fw.args,
          portControllable: true,
        };
      } else if (fw?.env && invokesFramework) {
        start = runScript(pm, scriptName, []);
        binding = { env: fw.env, portControllable: true };
      } else {
        start = runScript(pm, scriptName, []);
        if (fw && fw.args && !invokesFramework) {
          warnings.push(`Script "${scriptName}" doesn't call ${fw.bins[0]} directly; the port will be discovered from output.`);
        }
      }
    } else {
      const entry = [pkg.main, "server.js", "index.js", "app.js", "main.js", "server.mjs", "index.mjs"].find(
        (f) => f && ctx.exists(f),
      );
      if (entry) {
        start = cmd("node", entry);
        evidence.push(`entry: ${entry}`);
      } else {
        warnings.push("package.json has no dev/start script and no entry file.");
      }
    }

    const install: CommandSpec[] | undefined = ctx.isDir("node_modules")
      ? undefined
      : [pm === "yarn" ? cmd("yarn", "install") : cmd(pm, "install")];

    const framework = fw ? (ui && ["vite", "cra"].includes(fw.id) ? `${fw.label} + ${ui}` : fw.label) : ui;
    const result: DetectionResult = {
      detector: "node",
      language: "node",
      runtime: "native",
      confidence: start ? (fw ? 0.92 : 0.8) : 0.3,
      evidence,
      binding,
      defaultPort: fw?.port ?? 3000,
      ...(framework ? { framework } : {}),
      ...(start ? { start } : {}),
      ...(install ? { install } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
    return result;
  },
};
