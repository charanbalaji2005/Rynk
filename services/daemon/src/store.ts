import { newId, type DeploymentState, type DeploymentURLs, type DeviceInfo, type HealthStatus, type LogEntry, type ProjectDefinition, type Route, type RynkNode } from "@rynk/core";
import { SecretBox } from "./secrets.js";
import { and, desc, eq, lt, schema, sql, type DatabaseHandle } from "@rynk/database";
import type { PortStore } from "@rynk/ports";

export interface DeploymentRow {
  id: string;
  projectId: string;
  state: DeploymentState;
  health: HealthStatus;
  port: number | null;
  pid: number | null;
  containerId: string | null;
  urls: DeploymentURLs | null;
  error: unknown;
  restartCount: number;
  desired: "running" | "stopped";
  startedAt: number | null;
  liveAt: number | null;
  stoppedAt: number | null;
  command?: string | null;
  cwd?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type HostingStatus = "starting" | "live" | "degraded" | "unhealthy" | "restarting" | "stopping" | "stopped" | "failed";

/** One period of hosting a project — what a share link belongs to. */
export interface HostingSessionRow {
  id: string;
  nodeId: string;
  projectId: string;
  deploymentId: string;
  projectName: string;
  hostAddress: string | null;
  internalPort: number | null;
  sharePort: number | null;
  localUrl: string | null;
  shareUrl: string | null;
  exposure: string;
  accessMode: string;
  maxUsers: number;
  peakUsers: number;
  status: HostingStatus;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

/**
 * Repository over SQLite. All persistence goes through here so the engine
 * never builds SQL. Log writes are batched to keep idle I/O near zero.
 */
export class Store {
  private logBuffer: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly h: DatabaseHandle, private readonly secrets?: SecretBox) {}

  private openDef<T extends { definition: unknown }>(row: T | undefined): T | undefined {
    if (!row || !this.secrets) return row;
    return { ...row, definition: this.secrets.openEnv(row.definition as { env?: unknown }) };
  }

  get db() {
    return this.h.db;
  }

  // ── projects ──────────────────────────────────────────────
  async upsertProject(p: ProjectDefinition) {
    const now = Date.now();
    const definition = this.secrets ? this.secrets.sealEnv(p) : p;
    await this.db
      .insert(schema.projects)
      .values({ id: p.id, name: p.name, root: p.root, language: p.language, framework: p.framework ?? null, runtime: p.runtime, definition, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: schema.projects.id, set: { name: p.name, language: p.language, framework: p.framework ?? null, runtime: p.runtime, definition, updatedAt: now } });
  }

  async listProjects() {
    return (await this.db.select().from(schema.projects).orderBy(desc(schema.projects.updatedAt))).map((r) => this.openDef(r)!);
  }

  async getProject(idOrName: string) {
    const byId = await this.db.select().from(schema.projects).where(eq(schema.projects.id, idOrName)).get();
    if (byId) return this.openDef(byId);
    return this.openDef(await this.db.select().from(schema.projects).where(eq(schema.projects.name, idOrName)).orderBy(desc(schema.projects.updatedAt)).get());
  }

  async getProjectByRoot(root: string) {
    return this.db.select().from(schema.projects).where(eq(schema.projects.root, root)).get();
  }

  async deleteProject(id: string) {
    await this.db.delete(schema.projects).where(eq(schema.projects.id, id));
    await this.db.delete(schema.logs).where(eq(schema.logs.projectId, id));
    await this.db.delete(schema.ports).where(eq(schema.ports.projectId, id));
    await this.db.delete(schema.routes).where(eq(schema.routes.projectId, id));
  }

  // ── deployments ───────────────────────────────────────────
  async createDeployment(projectId: string): Promise<DeploymentRow> {
    const now = Date.now();
    const row = { id: newId("dep_"), projectId, state: "CREATED" as const, health: "UNKNOWN" as const, createdAt: now, updatedAt: now, desired: "running" as const, restartCount: 0 };
    await this.db.insert(schema.deployments).values(row);
    return (await this.getDeployment(row.id))!;
  }

  async insertDeployment(id: string, projectId: string, state: DeploymentState) {
    const now = Date.now();
    await this.db.insert(schema.deployments).values({ id, projectId, state, health: "UNKNOWN", desired: "running", restartCount: 0, createdAt: now, updatedAt: now });
  }

  async updateDeployment(id: string, patch: Partial<Omit<DeploymentRow, "id" | "projectId" | "createdAt">>) {
    await this.db.update(schema.deployments).set({ ...patch, updatedAt: Date.now() } as never).where(eq(schema.deployments.id, id));
  }

  async getDeployment(id: string): Promise<DeploymentRow | undefined> {
    return (await this.db.select().from(schema.deployments).where(eq(schema.deployments.id, id)).get()) as DeploymentRow | undefined;
  }

  async latestDeployment(projectId: string): Promise<DeploymentRow | undefined> {
    return (await this.db.select().from(schema.deployments).where(eq(schema.deployments.projectId, projectId)).orderBy(desc(schema.deployments.createdAt)).limit(1).get()) as DeploymentRow | undefined;
  }

  async listDeployments(limit = 100): Promise<DeploymentRow[]> {
    return (await this.db.select().from(schema.deployments).orderBy(desc(schema.deployments.createdAt)).limit(limit)) as DeploymentRow[];
  }

  /** Deployments the user wants running — restored after a daemon restart. */
  async desiredRunning(): Promise<DeploymentRow[]> {
    const rows = (await this.db.select().from(schema.deployments).where(eq(schema.deployments.desired, "running"))) as DeploymentRow[];
    const latest = new Map<string, DeploymentRow>();
    for (const r of rows) if (!latest.has(r.projectId) || latest.get(r.projectId)!.createdAt < r.createdAt) latest.set(r.projectId, r);
    return [...latest.values()].filter((r) => r.state !== "FAILED");
  }

  // ── ports ─────────────────────────────────────────────────
  portStore(): PortStore {
    return {
      load: async () => new Map((await this.db.select().from(schema.ports)).map((r) => [r.projectId, r.port])),
      save: async (projectId, port) => {
        await this.db.insert(schema.ports).values({ projectId, port, updatedAt: Date.now() }).onConflictDoUpdate({ target: schema.ports.projectId, set: { port, updatedAt: Date.now() } });
      },
      remove: async (projectId) => {
        await this.db.delete(schema.ports).where(eq(schema.ports.projectId, projectId));
      },
    };
  }

  // ── routes ────────────────────────────────────────────────
  async saveRoute(r: Route) {
    await this.db.insert(schema.routes).values({ id: r.id, projectId: r.projectId, pathPrefix: r.pathPrefix, hostnames: r.hostnames, targetPort: r.targetPort, createdAt: Date.now() }).onConflictDoUpdate({ target: schema.routes.id, set: { targetPort: r.targetPort, pathPrefix: r.pathPrefix, hostnames: r.hostnames } });
  }
  async removeRoute(id: string) {
    await this.db.delete(schema.routes).where(eq(schema.routes.id, id));
  }

  // ── logs (batched) ────────────────────────────────────────
  appendLog(e: LogEntry) {
    this.logBuffer.push(e);
    if (this.logBuffer.length >= 500) void this.flushLogs();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flushLogs(), 500);
      this.flushTimer.unref();
    }
  }

  async flushLogs() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const batch = this.logBuffer.splice(0);
    if (!batch.length) return;
    const stmt = this.h.raw.prepare("INSERT INTO logs (project_id, deployment_id, timestamp, level, stream, source, message, hosting_session_id, pid, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    this.h.raw.exec("BEGIN");
    try {
      for (const e of batch) {
        stmt.run(e.projectId ?? null, e.deploymentId ?? null, e.timestamp, e.level, e.stream ?? null, e.source, e.message.slice(0, 16_384),
          e.hostingSessionId ?? null, e.pid ?? null, e.metadata ? JSON.stringify(e.metadata).slice(0, 4096) : null);
      }
      this.h.raw.exec("COMMIT");
    } catch {
      this.h.raw.exec("ROLLBACK");
    }
  }

  async recentLogs(projectId: string, limit: number, since?: number): Promise<LogEntry[]> {
    await this.flushLogs();
    const where = since ? and(eq(schema.logs.projectId, projectId), sql`${schema.logs.timestamp} > ${since}`) : eq(schema.logs.projectId, projectId);
    const rows = await this.db.select().from(schema.logs).where(where).orderBy(desc(schema.logs.id)).limit(limit);
    return rows.reverse().map((r) => ({
      timestamp: r.timestamp,
      level: r.level as LogEntry["level"],
      source: r.source,
      message: r.message,
      ...(r.stream ? { stream: r.stream as LogEntry["stream"] } : {}),
      ...(r.projectId ? { projectId: r.projectId } : {}),
      ...(r.deploymentId ? { deploymentId: r.deploymentId } : {}),
      ...(r.hostingSessionId ? { hostingSessionId: r.hostingSessionId } : {}),
      ...(r.pid ? { pid: r.pid } : {}),
      ...(r.metadata ? { metadata: r.metadata as Record<string, unknown> } : {}),
    }));
  }

  /** Retention: keep the newest N log lines per project, 24h of metrics, and clean stale records. */
  prune(maxLogsPerProject = 10_000) {
    try {
      this.h.raw.exec(`DELETE FROM logs WHERE id IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY id DESC) AS rn FROM logs) WHERE rn > ${maxLogsPerProject})`);
      const cutoff = Date.now() - 24 * 3_600_000;
      void this.db.delete(schema.metrics).where(lt(schema.metrics.timestamp, cutoff));
      void this.db.delete(schema.healthChecks).where(lt(schema.healthChecks.timestamp, cutoff));
      void this.db.delete(schema.events).where(lt(schema.events.timestamp, cutoff));
      const month = Date.now() - 30 * 86_400_000;
      this.h.raw.prepare("DELETE FROM hosting_sessions WHERE ended_at IS NOT NULL AND ended_at < ?").run(month);
      this.h.raw.prepare("DELETE FROM nodes WHERE last_seen < ?").run(month);
      this.h.raw.prepare("DELETE FROM ports WHERE project_id NOT IN (SELECT id FROM projects)").run();
    } catch {
      /* ignore retention cleanup errors */
    }
  }

  // ── metrics / health / events ─────────────────────────────
  async recordMetrics(deploymentId: string, cpu: number, memoryBytes: number) {
    await this.db.insert(schema.metrics).values({ deploymentId, cpu, memoryBytes, timestamp: Date.now() });
  }
  async metricsFor(deploymentId: string, limit = 120) {
    return (await this.db.select().from(schema.metrics).where(eq(schema.metrics.deploymentId, deploymentId)).orderBy(desc(schema.metrics.id)).limit(limit)).reverse();
  }
  async recordHealth(deploymentId: string, status: HealthStatus, latencyMs?: number, detail?: string) {
    await this.db.insert(schema.healthChecks).values({ deploymentId, status, latencyMs: latencyMs ?? null, detail: detail ?? null, timestamp: Date.now() });
  }
  async recordEvent(type: string, payload: unknown) {
    await this.db.insert(schema.events).values({ type, payload, timestamp: Date.now() });
  }

  // ── devices ───────────────────────────────────────────────
  async upsertDevice(d: DeviceInfo) {
    await this.db.insert(schema.devices).values({ id: d.id, hostname: d.hostname, info: d, status: d.status, lastHeartbeat: d.lastHeartbeat }).onConflictDoUpdate({ target: schema.devices.id, set: { hostname: d.hostname, info: d, status: d.status, lastHeartbeat: d.lastHeartbeat } });
  }
  async listDevices() {
    return (await this.db.select().from(schema.devices)).map((r) => r.info as DeviceInfo);
  }

  // ── settings ──────────────────────────────────────────────
  async getSetting<T>(key: string): Promise<T | undefined> {
    const v = (await this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get())?.value as T | undefined;
    return v && this.secrets && typeof v === "object" ? (this.secrets.openEnv(v as { env?: unknown }) as T) : v;
  }
  async setSetting(key: string, value: unknown) {
    const stored = value && this.secrets && typeof value === "object" ? this.secrets.sealEnv(value as { env?: unknown }) : value;
    await this.db.insert(schema.settings).values({ key, value: stored }).onConflictDoUpdate({ target: schema.settings.key, set: { value: stored } });
  }

  // ── hosting sessions ──────────────────────────────────────
  async createHostingSession(row: Omit<HostingSessionRow, "id" | "createdAt" | "updatedAt" | "endedAt" | "peakUsers">): Promise<HostingSessionRow> {
    const now = Date.now();
    const full: HostingSessionRow = { ...row, id: newId("hs_"), peakUsers: 0, createdAt: now, updatedAt: now, endedAt: null };
    await this.db.insert(schema.hostingSessions).values(full);
    return full;
  }
  async updateHostingSession(id: string, patch: Partial<Omit<HostingSessionRow, "id" | "createdAt">>) {
    await this.db.update(schema.hostingSessions).set({ ...patch, updatedAt: Date.now() }).where(eq(schema.hostingSessions.id, id));
  }
  async getHostingSession(id: string): Promise<HostingSessionRow | undefined> {
    return (await this.db.select().from(schema.hostingSessions).where(eq(schema.hostingSessions.id, id)).get()) as HostingSessionRow | undefined;
  }
  async listHostingSessions(opts: { projectId?: string; limit?: number } = {}): Promise<HostingSessionRow[]> {
    const q = this.db.select().from(schema.hostingSessions);
    const rows = opts.projectId ? await q.where(eq(schema.hostingSessions.projectId, opts.projectId)).orderBy(desc(schema.hostingSessions.createdAt)).limit(opts.limit ?? 50) : await q.orderBy(desc(schema.hostingSessions.createdAt)).limit(opts.limit ?? 50);
    return rows as HostingSessionRow[];
  }
  /** Close sessions left "live" by a daemon that died. */
  async endOrphanedHostingSessions() {
    this.h.raw.prepare("UPDATE hosting_sessions SET status = 'stopped', ended_at = ?, updated_at = ? WHERE ended_at IS NULL").run(Date.now(), Date.now());
  }

  // ── discovered nodes (no visitor data) ────────────────────
  async upsertNode(n: RynkNode & { publicKey?: string }) {
    const now = Date.now();
    this.h.raw
      .prepare(`INSERT INTO nodes (node_id, name, public_key, last_address, platform, version, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET name = excluded.name, public_key = COALESCE(excluded.public_key, nodes.public_key), last_address = excluded.last_address,
        platform = excluded.platform, version = excluded.version, last_seen = excluded.last_seen`)
      .run(n.nodeId, n.name, n.publicKey ?? null, n.address, n.platform || null, n.version || null, now, now);
  }
  async listKnownNodes() {
    return this.db.select().from(schema.nodes).orderBy(desc(schema.nodes.lastSeen));
  }

  async close() {
    await this.flushLogs();
    this.h.close();
  }
}
