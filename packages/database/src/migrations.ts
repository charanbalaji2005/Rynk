/**
 * Ordered, append-only migrations. Never edit a shipped migration —
 * add a new one. Applied inside a transaction and tracked in _migrations.
 */
export const MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: "initial",
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, language TEXT, framework TEXT,
  runtime TEXT NOT NULL, definition TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE deployments (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL, health TEXT NOT NULL DEFAULT 'UNKNOWN', port INTEGER, pid INTEGER, container_id TEXT,
  urls TEXT, error TEXT, restart_count INTEGER NOT NULL DEFAULT 0, desired TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER, live_at INTEGER, stopped_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX deployments_project_idx ON deployments(project_id);
CREATE TABLE ports (project_id TEXT PRIMARY KEY, port INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE routes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path_prefix TEXT NOT NULL, hostnames TEXT NOT NULL,
  target_port INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, deployment_id TEXT, timestamp INTEGER NOT NULL,
  level TEXT NOT NULL, stream TEXT, source TEXT NOT NULL, message TEXT NOT NULL
);
CREATE INDEX logs_project_ts_idx ON logs(project_id, timestamp);
CREATE TABLE devices (id TEXT PRIMARY KEY, hostname TEXT NOT NULL, info TEXT NOT NULL, status TEXT NOT NULL, last_heartbeat INTEGER NOT NULL);
CREATE TABLE health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deployment_id TEXT NOT NULL, status TEXT NOT NULL,
  latency_ms INTEGER, detail TEXT, timestamp INTEGER NOT NULL
);
CREATE TABLE metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, deployment_id TEXT NOT NULL, cpu REAL, memory_bytes INTEGER, timestamp INTEGER NOT NULL);
CREATE INDEX metrics_deployment_ts_idx ON metrics(deployment_id, timestamp);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT, timestamp INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
`,
  },
  {
    id: 2,
    name: "hosting-sessions-nodes-log-metadata",
    sql: `
CREATE TABLE hosting_sessions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  project_name TEXT NOT NULL,
  host_address TEXT,
  internal_port INTEGER,
  share_port INTEGER,
  local_url TEXT,
  share_url TEXT,
  exposure TEXT NOT NULL,
  access_mode TEXT NOT NULL DEFAULT 'open',
  max_users INTEGER NOT NULL DEFAULT 0,
  peak_users INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX hosting_sessions_project_idx ON hosting_sessions(project_id, created_at);
CREATE INDEX hosting_sessions_status_idx ON hosting_sessions(status);
CREATE UNIQUE INDEX hosting_sessions_deployment_idx ON hosting_sessions(deployment_id);
CREATE TABLE nodes (
  node_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT,
  last_address TEXT,
  platform TEXT,
  version TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
ALTER TABLE logs ADD COLUMN hosting_session_id TEXT;
ALTER TABLE logs ADD COLUMN pid INTEGER;
ALTER TABLE logs ADD COLUMN metadata TEXT;
CREATE INDEX logs_deployment_idx ON logs(deployment_id);
ALTER TABLE deployments ADD COLUMN command TEXT;
ALTER TABLE deployments ADD COLUMN cwd TEXT;
CREATE INDEX deployments_desired_idx ON deployments(desired, state);
CREATE INDEX events_ts_idx ON events(timestamp);
CREATE INDEX health_checks_deployment_idx ON health_checks(deployment_id, timestamp);
`,
  },
];
