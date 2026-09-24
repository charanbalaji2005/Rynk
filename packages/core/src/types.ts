/**
 * Canonical domain model for Rynk. Every other package speaks these types.
 * Framework-specific knowledge never appears here — only the universal
 * abstraction: directory, commands, env, host, port, health, exposure.
 */

export type RuntimeKind = "native" | "docker" | "compose" | "static" | "custom";

export type ExposureMode = "local" | "lan" | "public";

export type RestartPolicy = "never" | "on-failure" | "always";

export type HealthCheckType = "http" | "tcp" | "process" | "command" | "none";

/** A command expressed as argv — never a raw shell string. */
export interface CommandSpec {
  file: string;
  args: string[];
  /** Human readable form for display only. */
  display: string;
  /** True when the user explicitly requested shell semantics in rynk.yaml. */
  shell?: boolean;
}

export interface HealthCheckSpec {
  type: HealthCheckType;
  path?: string;
  intervalMs: number;
  timeoutMs: number;
  /** Maximum time to wait for the first healthy result during startup. */
  startupTimeoutMs: number;
  command?: CommandSpec;
}

export interface RestartSpec {
  policy: RestartPolicy;
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
}

/**
 * How the runtime tells the application which host/port to use. Detectors
 * fill this in so the core never needs to know framework CLI flags.
 */
export interface BindingStrategy {
  /** Environment variables to set. `{port}` and `{host}` are substituted. */
  env?: Record<string, string>;
  /** Extra argv appended to the start command. `{port}` and `{host}` substituted. */
  args?: string[];
  /** Whether the app honours the port we give it. If false we discover it from output. */
  portControllable: boolean;
}

export interface ProjectDefinition {
  id: string;
  name: string;
  root: string;
  runtime: RuntimeKind;
  /** Language/ecosystem, e.g. "node", "python". */
  language: string;
  framework?: string;
  install?: CommandSpec[];
  build?: CommandSpec[];
  start: CommandSpec;
  env: Record<string, string>;
  host: string;
  /** Explicitly requested port, if any. */
  port?: number;
  /** Port the app uses by default when it cannot be told otherwise. */
  defaultPort?: number;
  binding: BindingStrategy;
  health: HealthCheckSpec;
  restart: RestartSpec;
  exposure: ExposureMode;
  /** Docker-specific metadata, used only by container runtimes. */
  container?: {
    dockerfile?: string;
    composeFile?: string;
    containerPort?: number;
    service?: string;
  };
  /** Static runtime document root. */
  staticDir?: string;
  /** Who may use the share link and how many at once. */
  access: AccessConfig;
  source: ConfigSource[];
}

export type AccessMode = "open" | "protected";

export interface AccessConfig {
  /** open: anyone who can reach the link; protected: only people with an invite link. */
  mode: AccessMode;
  /** Maximum concurrently active client sessions; 0 = unlimited. */
  maxUsers: number;
  /** A session with no requests and no open connections for this long stops counting as active. */
  idleTimeoutMs: number;
  /** Announce this app to other Rynk nodes on the network. */
  advertise: boolean;
  /** How long an idle visitor's address/session is remembered before being forgotten. */
  clientRetentionMs: number;
}

/**
 * A client of a hosted app, as seen by the Rynk access gateway. A session is
 * bound to a cookie (or, for clients that refuse cookies, to their address and
 * user agent) — never to an IP address alone.
 */
export interface ClientSession {
  sessionId: string;
  /** Network address observed on the TCP connection (the last hop, see docs/access-control.md). */
  clientAddress: string;
  userAgent?: string;
  connectedAt: number;
  lastSeenAt: number;
  status: "active" | "idle" | "closed";
  requests: number;
  openConnections: number;
  identifiedBy: "cookie" | "fingerprint";
  invited: boolean;
}

export interface InviteLink {
  id: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revoked: boolean;
  url?: string;
}

/** An application as advertised to other Rynk nodes (public, non-sensitive fields only). */
export interface RynkApp {
  id: string;
  name: string;
  framework?: string;
  runtime: string;
  url: string;
  port: number;
  status: string;
  access: AccessMode;
}

export interface RynkNode {
  nodeId: string;
  name: string;
  hostname: string;
  address: string;
  addresses: string[];
  apiPort: number;
  platform: string;
  arch: string;
  version: string;
  rev: number;
  capabilities: string[];
  apps: RynkApp[];
  status: "ONLINE" | "UNREACHABLE" | "OFFLINE";
  lastSeen: number;
  self?: boolean;
  via?: string[];
  /** The node proved it owns its id (signed description). */
  verified?: boolean;
  /** Ed25519 public key (base64 DER) whose hash is the node id. */
  publicKey?: string;
}

export type ConfigSource = "cli" | "rynk.yaml" | "metadata" | "detector" | "defaults";

/** How Rynk can steer a project's host/port and supervise it (derived, per project). */
export interface RuntimeCapabilities {
  supportsHostFlag: boolean;
  supportsPortFlag: boolean;
  supportsHostEnv: boolean;
  supportsPortEnv: boolean;
  supportsHealthCheck: boolean;
  supportsGracefulShutdown: boolean;
}

export interface DetectionResult {
  detector: string;
  language: string;
  /** npm, pnpm, yarn, bun, pip, uv, poetry, pipenv, cargo, go, maven, gradle, composer, bundler, dotnet, deno. */
  packageManager?: string;
  framework?: string;
  runtime: RuntimeKind;
  confidence: number;
  evidence: string[];
  install?: CommandSpec[];
  build?: CommandSpec[];
  start?: CommandSpec;
  defaultPort?: number;
  binding?: BindingStrategy;
  healthPath?: string;
  staticDir?: string;
  container?: ProjectDefinition["container"];
  warnings?: string[];
}

export interface DeploymentURLs {
  local: string;
  network?: string;
  networkAll?: string[];
  proxy?: string;
  public?: string;
}

export type HealthStatus =
  | "UNKNOWN"
  | "STARTING"
  | "HEALTHY"
  | "DEGRADED"
  | "UNHEALTHY"
  | "CRASHED"
  | "STOPPED";

export interface RuntimeMetrics {
  cpu: number;
  memoryBytes: number;
  uptimeMs: number;
  restartCount: number;
  timestamp: number;
}

export interface LogEntry {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  stream?: "stdout" | "stderr" | "system";
  projectId?: string;
  deploymentId?: string;
  /** Hosting session the line belongs to (set once the app is shared). */
  hostingSessionId?: string;
  /** Process that produced the line. */
  pid?: number;
  /** This machine's Rynk node id. */
  nodeId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  kind: "wifi" | "ethernet" | "vpn" | "virtual" | "loopback" | "unknown";
  private: boolean;
  score: number;
  /** The OS routes default (internet) traffic through this address. */
  defaultRoute?: boolean;
  /** Default gateway reached through this interface, when known. */
  gateway?: string;
  /** Netmask/prefix, e.g. 192.168.1.0/24. */
  cidr?: string;
}

export interface Route {
  id: string;
  projectId: string;
  name: string;
  /** Path prefix, e.g. "/portfolio". */
  pathPrefix: string;
  /** Hostname match, e.g. "portfolio.localhost". */
  hostnames: string[];
  targetHost: string;
  targetPort: number;
}

export interface DeviceInfo {
  id: string;
  hostname: string;
  os: string;
  arch: string;
  cpus: number;
  memoryBytes: number;
  runtimes: Record<string, string | null>;
  addresses: string[];
  status: "ONLINE" | "UNREACHABLE" | "OFFLINE";
  lastHeartbeat: number;
  labels: Record<string, string>;
}
