import path from "node:path";
import { paths } from "@rynk/core";
import type { RynkYaml } from "@rynk/config";
import type { Detector, DetectorRegistry } from "@rynk/detector";
import type { ExposureProvider, ExposureRegistry } from "@rynk/exposure";
import type { Logger } from "@rynk/logger";
import { loadPlugins } from "@rynk/plugins";
import type { RuntimeAdapter, RuntimeRegistry } from "@rynk/runtime";

const isDetector = (x: unknown): x is Detector => !!x && typeof (x as Detector).name === "string" && typeof (x as Detector).detect === "function";
const isRuntime = (x: unknown): x is RuntimeAdapter => !!x && typeof (x as RuntimeAdapter).kind === "string" && typeof (x as RuntimeAdapter).start === "function";
const isExposure = (x: unknown): x is ExposureProvider => !!x && typeof (x as ExposureProvider).name === "string" && typeof (x as ExposureProvider).create === "function";

/** Loads plugins declared globally (RYNK_PLUGINS) or per project (rynk.yaml `plugins:`). */
export class PluginManager {
  private loaded = new Set<string>();

  constructor(
    private readonly registries: { detectors: DetectorRegistry; runtimes: RuntimeRegistry; exposures: ExposureRegistry },
    private readonly logger: Logger,
  ) {}

  async loadGlobal() {
    const specs = (process.env.RYNK_PLUGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    await this.load(specs);
  }

  async loadForProject(root: string, yaml: RynkYaml | null) {
    if (yaml?.plugins?.length) await this.load(yaml.plugins, root);
  }

  list() {
    return [...this.loaded];
  }

  private async load(specs: string[], projectRoot?: string) {
    const fresh = specs.filter((s) => !this.loaded.has(projectRoot && s.startsWith(".") ? path.resolve(projectRoot, s) : s));
    if (!fresh.length) return;
    for (const r of await loadPlugins(fresh, { pluginDir: paths.plugins(), ...(projectRoot ? { projectRoot } : {}) })) {
      if (r.error || !r.plugin) {
        this.logger.warn(`Plugin ${r.specifier} failed to load: ${r.error}`);
        continue;
      }
      const p = r.plugin;
      p.detectors?.filter(isDetector).forEach((d) => this.registries.detectors.register(d));
      p.runtimes?.filter(isRuntime).forEach((rt) => this.registries.runtimes.register(rt));
      p.exposures?.filter(isExposure).forEach((e) => this.registries.exposures.register(e));
      await p.setup?.({ log: (m) => this.logger.info(`[${p.name}] ${m}`) });
      this.loaded.add(projectRoot && r.specifier.startsWith(".") ? path.resolve(projectRoot, r.specifier) : r.specifier);
      this.logger.info(`Loaded plugin ${p.name}`);
    }
  }
}
