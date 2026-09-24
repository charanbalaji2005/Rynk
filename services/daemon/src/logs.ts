import type { LogEntry } from "@rynk/core";
import type { EventBus } from "@rynk/events";
import { RingBuffer } from "@rynk/logger";
import { defaultRedactor } from "@rynk/security";
import type { Store } from "./store.js";

/**
 * Collects application output: redacts secrets, keeps a hot ring buffer per
 * project for instant tailing, persists in batches, and publishes to the bus.
 */
export class LogManager {
  private buffers = new Map<string, RingBuffer<LogEntry>>();
  private context = new Map<string, { hostingSessionId?: string; pid?: number }>();

  constructor(private readonly store: Store, private readonly bus: EventBus, private readonly nodeId?: string) {}

  /** Attach hosting-session / process metadata to every later line of a deployment. */
  bind(deploymentId: string, ctx: { hostingSessionId?: string; pid?: number }) {
    this.context.set(deploymentId, { ...this.context.get(deploymentId), ...ctx });
  }

  unbind(deploymentId: string) {
    this.context.delete(deploymentId);
  }

  write(projectId: string, deploymentId: string, message: string, stream: LogEntry["stream"] = "stdout", level?: LogEntry["level"]) {
     
    const clean = defaultRedactor.redact(message.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, ""));
    if (!clean.trim() && stream !== "system") return;
    const entry: LogEntry = {
      timestamp: Date.now(),
      level: level ?? (stream === "stderr" && /error|exception|fatal|traceback/i.test(clean) ? "error" : stream === "stderr" ? "warn" : "info"),
      source: stream === "system" ? "rynk" : "app",
      stream,
      projectId,
      deploymentId,
      message: clean,
      ...(this.nodeId ? { nodeId: this.nodeId } : {}),
      ...this.context.get(deploymentId),
    };
    let buf = this.buffers.get(projectId);
    if (!buf) this.buffers.set(projectId, (buf = new RingBuffer(2000)));
    buf.push(entry);
    this.store.appendLog(entry);
    this.bus.emit("log.received", { entry });
  }

  system(projectId: string, deploymentId: string, message: string, level: LogEntry["level"] = "info") {
    this.write(projectId, deploymentId, message, "system", level);
  }

  tail(projectId: string, n: number): LogEntry[] {
    return this.buffers.get(projectId)?.tail(n) ?? [];
  }

  /** Last N lines of app output (used to explain startup failures). */
  lastOutput(projectId: string, deploymentId: string, n = 12): string[] {
    return (this.buffers.get(projectId)?.toArray() ?? []).filter((e) => e.deploymentId === deploymentId && e.stream !== "system").slice(-n).map((e) => e.message);
  }

  async recent(projectId: string, limit: number, since?: number): Promise<LogEntry[]> {
    const hot = this.tail(projectId, limit).filter((e) => !since || e.timestamp > since);
    const rows = hot.length >= limit ? hot : await this.store.recentLogs(projectId, limit, since);
    // The node id is per daemon, so it isn't stored per row; stamp it on every entry.
    return this.nodeId ? rows.map((e) => (e.nodeId ? e : { ...e, nodeId: this.nodeId })) : rows;
  }

  clear(projectId: string) {
    this.buffers.delete(projectId);
  }
}
