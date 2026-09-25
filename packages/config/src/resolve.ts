import path from "node:path";
import {
  canonicalPath,
  parseCommand,
  projectIdFor,
  slugify,
  parseDuration,
  RynkError,
  type CommandSpec,
  type ConfigSource,
  type DetectionResult,
  type ExposureMode,
  type ProjectDefinition,
  type RuntimeKind,
} from "@rynk/core";
import { commandString, type RynkYaml } from "./schema.js";

export interface CliOverrides {
  name?: string;
  runtime?: RuntimeKind | "auto";
  command?: string;
  port?: number;
  host?: string;
  exposure?: ExposureMode;
  env?: Record<string, string>;
  maxUsers?: number;
  accessMode?: "open" | "protected";
  advertise?: boolean;
  restartPolicy?: "never" | "on-failure" | "always";
  healthCheck?: boolean;
}

/**
 * Merge configuration with explicit precedence:
 *   CLI arguments → rynk.yaml → project metadata → detector → runtime defaults
 * An explicit value is never silently overridden by a lower layer.
 */
export function resolveProject(input: {
  root: string;
  cli?: CliOverrides;
  yaml?: RynkYaml | null;
  detection?: DetectionResult | null;
  packageName?: string;
}): ProjectDefinition {
  const root = canonicalPath(input.root);
  const cli = input.cli ?? {};
  const yaml = input.yaml ?? {};
  const det = input.detection ?? null;
  const sources = new Set<ConfigSource>(["defaults"]);
  if (det) sources.add("detector");
  if (input.packageName) sources.add("metadata");
  if (input.yaml) sources.add("rynk.yaml");
  if (Object.keys(cli).length) sources.add("cli");

  const allowShell = yaml.shell === true;
  const userCmd = (s: string | undefined, origin: string): CommandSpec | undefined => {
    if (!s) return undefined;
    try {
      return parseCommand(s, { allowShell: allowShell || origin === "cli" });
    } catch (e) {
      throw new RynkError("CONFIG_INVALID", (e as Error).message, {
        suggestions: ["Set `shell: true` in rynk.yaml to allow pipes and &&."],
      });
    }
  };

  const arr = (c: CommandSpec | undefined) => (c ? [c] : undefined);
  const yamlRuntime = typeof yaml.runtime === "string" ? yaml.runtime : yaml.runtime?.type;
  let runtime: RuntimeKind | "auto" = cli.runtime ?? yamlRuntime ?? "auto";
  const cliStart = userCmd(cli.command, "cli");
  const yamlStart = userCmd(commandString(yaml.start), "yaml");
  if (runtime === "auto") {
    const userStart = Boolean(cliStart || yamlStart);
    // An explicit start command beats "serve these files" or "run the container":
    // the user told us exactly what to run, so run it as a process.
    if (userStart && (!det || det.runtime === "static" || det.runtime === "docker" || det.runtime === "compose")) runtime = "custom";
    else runtime = det?.runtime ?? "native";
  }

  const start = cliStart ?? yamlStart ?? det?.start;
  if (!start && runtime !== "docker" && runtime !== "compose" && runtime !== "static") {
    throw new RynkError("DETECTION_FAILED", "Rynk couldn't work out how to start this project.", {
      causes: det?.warnings ?? ["No recognised project files were found."],
      suggestions: [
        'rynk start --cmd "<your start command>" --port <port>',
        "rynk init   # create a rynk.yaml you can edit",
      ],
    });
  }

  const yamlPort = yaml.server?.port === "auto" ? undefined : yaml.server?.port;
  const explicitPort = cli.port ?? yamlPort;
  const exposure: ExposureMode = cli.exposure ?? yaml.network?.exposure ?? yaml.network?.mode ?? "lan";
  const host = cli.host ?? yaml.server?.host ?? (exposure === "local" ? "127.0.0.1" : "0.0.0.0");

  // User-supplied start commands give up automatic port injection unless the
  // detector knows the same framework; we still pass PORT/HOST env vars.
  const userOverrodeStart = Boolean(cliStart ?? yamlStart);
  const binding = userOverrodeStart
    ? { env: { PORT: "{port}", HOST: "{host}" }, portControllable: false }
    : (det?.binding ?? { env: { PORT: "{port}", HOST: "{host}" }, portControllable: false });

  // --no-health-check keeps process supervision but skips HTTP probing.
  const healthType = cli.healthCheck === false ? "process" : (yaml.health?.type ?? "http");

  const def: ProjectDefinition = {
    id: projectIdFor(root),
    name: slugify(cli.name ?? yaml.name ?? input.packageName ?? path.basename(root)),
    root,
    runtime,
    language: det?.language ?? (runtime === "custom" ? "custom" : "unknown"),
    ...(det?.framework && !(runtime === "custom" && det.runtime !== "native") ? { framework: det.framework } : {}),
    install: arr(userCmd(commandString(yaml.install), "yaml")) ?? det?.install,
    build: arr(userCmd(commandString(yaml.build), "yaml")) ?? det?.build,
    start: start ?? { file: "", args: [], display: "(container)" },
    env: { ...(yaml.env ?? {}), ...(cli.env ?? {}) },
    host,
    ...(explicitPort !== undefined ? { port: explicitPort } : {}),
    ...(det?.defaultPort !== undefined ? { defaultPort: det.defaultPort } : {}),
    binding,
    health: {
      type: healthType,
      path: yaml.health?.path ?? det?.healthPath ?? "/",
      intervalMs: parseDuration(yaml.health?.interval, 10_000),
      timeoutMs: parseDuration(yaml.health?.timeout, 3_000),
      startupTimeoutMs: parseDuration(yaml.health?.startupTimeout, 120_000),
      ...(yaml.health?.command ? { command: userCmd(yaml.health.command, "yaml")! } : {}),
    },
    restart: {
      policy: cli.restartPolicy ?? yaml.restart?.policy ?? "on-failure",
      maxRetries: yaml.restart?.maxRetries ?? 5,
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
    },
    exposure,
    access: {
      mode: cli.accessMode ?? yaml.access?.mode ?? "open",
      maxUsers: cli.maxUsers ?? yaml.access?.maxUsers ?? 0,
      idleTimeoutMs: parseDuration(yaml.access?.idleTimeout, 60_000),
      advertise: cli.advertise ?? yaml.access?.advertise ?? exposure !== "local",
      clientRetentionMs: parseDuration(yaml.access?.clientRetention ?? process.env.RYNK_CLIENT_RETENTION, 10 * 60_000),
    },
    source: [...sources],
  };

  if (yaml.static?.dir) def.staticDir = path.resolve(root, yaml.static.dir);
  else if (det?.staticDir) def.staticDir = det.staticDir;

  if (det?.container || yaml.docker) {
    def.container = {
      ...(det?.container ?? {}),
      ...(yaml.docker?.dockerfile ? { dockerfile: yaml.docker.dockerfile } : {}),
      ...(yaml.docker?.compose ? { composeFile: yaml.docker.compose } : {}),
      ...(yaml.docker?.service ? { service: yaml.docker.service } : {}),
      ...(yaml.docker?.containerPort ? { containerPort: yaml.docker.containerPort } : {}),
    };
  }
  return def;
}
