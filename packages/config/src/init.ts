import { stringify } from "yaml";
import type { ProjectDefinition } from "@rynk/core";

/** Generate a commented rynk.yaml from a resolved project definition. */
export function renderRynkYaml(p: ProjectDefinition): string {
  const doc: Record<string, unknown> = {
    name: p.name,
    runtime: { type: p.runtime },
  };
  if (p.install?.length) doc.install = { command: p.install.map((c) => c.display).join(" && ") };
  if (p.build?.length) doc.build = { command: p.build.map((c) => c.display).join(" && ") };
  if ((p.install?.length ?? 0) > 1 || (p.build?.length ?? 0) > 1) doc.shell = true;
  if (p.start.file) doc.start = { command: p.start.display };
  doc.server = { host: p.host, port: p.port ?? "auto" };
  doc.health = { type: p.health.type, path: p.health.path ?? "/" };
  doc.network = { exposure: p.exposure };
  doc.restart = { policy: p.restart.policy, maxRetries: p.restart.maxRetries };
  const header = [
    "# Rynk project configuration",
    "# Everything here is optional — Rynk auto-detects when a field is missing.",
    "# Reference: https://github.com/rynk-dev/rynk/blob/main/docs/rynk-yaml.md",
    "",
  ].join("\n");
  return header + stringify(doc);
}
