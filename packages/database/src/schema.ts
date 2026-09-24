import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  root: text("root").notNull().unique(),
  language: text("language"),
  framework: text("framework"),
  runtime: text("runtime").notNull(),
  definition: text("definition", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const deployments = sqliteTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    health: text("health").notNull().default("UNKNOWN"),
    port: integer("port"),
    pid: integer("pid"),
    containerId: text("container_id"),
    urls: text("urls", { mode: "json" }),
    error: text("error", { mode: "json" }),
    restartCount: integer("restart_count").notNull().default(0),
    /** Whether the daemon should bring this deployment back after a restart. */
    desired: text("desired").notNull().default("running"),
    startedAt: integer("started_at"),
    liveAt: integer("live_at"),
    stoppedAt: integer("stopped_at"),
    /** Recorded so a PID is only ever killed if it still runs this command in this directory. */
    command: text("command"),
    cwd: text("cwd"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("deployments_project_idx").on(t.projectId)],
);

/** One period of hosting a project: the thing a share link belongs to. */
export const hostingSessions = sqliteTable("hosting_sessions", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  deploymentId: text("deployment_id").notNull().references(() => deployments.id, { onDelete: "cascade" }),
  projectName: text("project_name").notNull(),
  hostAddress: text("host_address"),
  internalPort: integer("internal_port"),
  sharePort: integer("share_port"),
  localUrl: text("local_url"),
  shareUrl: text("share_url"),
  exposure: text("exposure").notNull(),
  accessMode: text("access_mode").notNull().default("open"),
  maxUsers: integer("max_users").notNull().default(0),
  peakUsers: integer("peak_users").notNull().default(0),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  endedAt: integer("ended_at"),
});

/** Other Rynk nodes seen on the network (no visitor data). */
export const nodes = sqliteTable("nodes", {
  nodeId: text("node_id").primaryKey(),
  name: text("name").notNull(),
  publicKey: text("public_key"),
  lastAddress: text("last_address"),
  platform: text("platform"),
  version: text("version"),
  firstSeen: integer("first_seen").notNull(),
  lastSeen: integer("last_seen").notNull(),
});

export const ports = sqliteTable("ports", {
  projectId: text("project_id").primaryKey(),
  port: integer("port").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const routes = sqliteTable("routes", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  pathPrefix: text("path_prefix").notNull(),
  hostnames: text("hostnames", { mode: "json" }).notNull(),
  targetPort: integer("target_port").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const logs = sqliteTable(
  "logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id"),
    deploymentId: text("deployment_id"),
    timestamp: integer("timestamp").notNull(),
    level: text("level").notNull(),
    stream: text("stream"),
    source: text("source").notNull(),
    message: text("message").notNull(),
    hostingSessionId: text("hosting_session_id"),
    pid: integer("pid"),
    metadata: text("metadata", { mode: "json" }),
  },
  (t) => [index("logs_project_ts_idx").on(t.projectId, t.timestamp)],
);

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  hostname: text("hostname").notNull(),
  info: text("info", { mode: "json" }).notNull(),
  status: text("status").notNull(),
  lastHeartbeat: integer("last_heartbeat").notNull(),
});

export const healthChecks = sqliteTable("health_checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deploymentId: text("deployment_id").notNull(),
  status: text("status").notNull(),
  latencyMs: integer("latency_ms"),
  detail: text("detail"),
  timestamp: integer("timestamp").notNull(),
});

export const metrics = sqliteTable("metrics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deploymentId: text("deployment_id").notNull(),
  cpu: real("cpu"),
  memoryBytes: integer("memory_bytes"),
  timestamp: integer("timestamp").notNull(),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }),
  timestamp: integer("timestamp").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
});
