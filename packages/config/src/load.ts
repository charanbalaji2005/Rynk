import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { RynkError } from "@rynk/core";
import { rynkYamlSchema, type RynkYaml } from "./schema.js";

export const CONFIG_FILES = ["rynk.yaml", "rynk.yml", ".rynk.yaml"];

export function findConfigFile(root: string): string | null {
  for (const f of CONFIG_FILES) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadRynkYaml(root: string): { file: string; config: RynkYaml } | null {
  const file = findConfigFile(root);
  if (!file) return null;
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new RynkError("CONFIG_INVALID", `${path.basename(file)} is not valid YAML.`, {
      cause: e,
      suggestions: ["Check indentation and quoting.", "rynk init --force to regenerate it."],
    });
  }
  const parsed = rynkYamlSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new RynkError("CONFIG_INVALID", `${path.basename(file)} has invalid settings.`, {
      causes: issues,
      suggestions: ["See docs/rynk-yaml.md for the full reference."],
    });
  }
  return { file, config: parsed.data };
}
