import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Plugin contract. Types are structural (unknown) here so the plugin package
 * stays dependency-free; the daemon narrows them when registering.
 *
 *   export default {
 *     name: "@rynk/detector-laravel",
 *     detectors: [...], runtimes: [...], exposures: [...],
 *   } satisfies RynkPlugin;
 */
export interface RynkPlugin<D = unknown, R = unknown, E = unknown> {
  name: string;
  version?: string;
  detectors?: D[];
  runtimes?: R[];
  exposures?: E[];
  commands?: Array<{ name: string; description: string; run(args: string[]): Promise<void> | void }>;
  setup?(ctx: { log: (msg: string) => void }): Promise<void> | void;
}

export function definePlugin<P extends RynkPlugin>(p: P): P {
  return p;
}

export interface LoadedPlugin {
  specifier: string;
  plugin?: RynkPlugin;
  error?: string;
}

/**
 * Load plugins by package name (resolved from the project, then RYNK_HOME/plugins)
 * or by relative path. Failures are isolated: one bad plugin never breaks Rynk.
 */
export async function loadPlugins(specifiers: string[], opts: { projectRoot?: string; pluginDir: string }): Promise<LoadedPlugin[]> {
  const out: LoadedPlugin[] = [];
  for (const spec of specifiers) {
    try {
      const url = resolvePlugin(spec, opts);
      const mod = (await import(url)) as { default?: RynkPlugin } & RynkPlugin;
      const plugin = mod.default ?? mod;
      if (!plugin || typeof plugin.name !== "string") throw new Error("module does not export a Rynk plugin");
      out.push({ specifier: spec, plugin });
    } catch (e) {
      out.push({ specifier: spec, error: (e as Error).message });
    }
  }
  return out;
}

function resolvePlugin(spec: string, opts: { projectRoot?: string; pluginDir: string }): string {
  if (spec.startsWith(".") || path.isAbsolute(spec)) {
    const p = path.resolve(opts.projectRoot ?? process.cwd(), spec);
    if (!fs.existsSync(p)) throw new Error(`plugin file not found: ${p}`);
    return pathToFileURL(p).href;
  }
  for (const base of [opts.projectRoot, opts.pluginDir].filter(Boolean) as string[]) {
    const pkgDir = path.join(base, "node_modules", spec);
    const pkgJson = path.join(pkgDir, "package.json");
    if (fs.existsSync(pkgJson)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8")) as { main?: string; exports?: unknown };
      const entry = typeof pkg.exports === "string" ? pkg.exports : (pkg.main ?? "index.js");
      return pathToFileURL(path.join(pkgDir, entry)).href;
    }
  }
  throw new Error(`plugin "${spec}" is not installed (npm install ${spec} in your project or ${opts.pluginDir})`);
}
