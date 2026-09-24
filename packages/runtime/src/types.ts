import type { CommandSpec, ProjectDefinition, RuntimeKind } from "@rynk/core";
import type { ExitInfo, ProcessStats } from "@rynk/process";

export interface RuntimeContext {
  /** Host port the app must be reachable on. */
  port: number;
  /** Interface the app should bind to (0.0.0.0 for LAN, 127.0.0.1 for local). */
  host: string;
  /** Whether commands came from the user (cli/rynk.yaml) or a detector. */
  origin: "user" | "detector";
  onLine: (line: string, stream: "stdout" | "stderr" | "system") => void;
  signal?: AbortSignal;
}

/**
 * A running workload. Stop/status/logs/metrics live on the instance itself,
 * so the daemon's registry maps deployment ids → instances.
 */
export interface RuntimeInstance {
  readonly kind: RuntimeKind;
  readonly pid?: number;
  readonly containerId?: string;
  readonly startedAt: number;
  readonly command: CommandSpec;
  alive(): boolean;
  readonly exited: Promise<ExitInfo>;
  stop(graceMs?: number): Promise<void>;
  stats(): Promise<ProcessStats | null>;
}

export interface Availability {
  ok: boolean;
  version?: string;
  reason?: string;
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  available(project?: ProjectDefinition): Promise<Availability>;
  install(project: ProjectDefinition, ctx: RuntimeContext): Promise<void>;
  build(project: ProjectDefinition, ctx: RuntimeContext): Promise<void>;
  start(project: ProjectDefinition, ctx: RuntimeContext): Promise<RuntimeInstance>;
  cleanup?(project: ProjectDefinition): Promise<void>;
}
