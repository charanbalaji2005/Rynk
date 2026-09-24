import fs from "node:fs";
import WebSocket from "ws";
import { paths, RynkError, type AccessConfig, type ClientSession, type DeploymentURLs, type DeploymentState, type DetectionResult, type HealthStatus, type InviteLink, type LogEntry, type NetworkInterfaceInfo, type ProjectDefinition, type RuntimeCapabilities, type RynkApp, type RynkNode, type StartRequest } from "@rynk/core";

export interface DaemonState {
  pid: number;
  host: string;
  port: number;
  token: string;
  version: string;
  startedAt: number;
  proxyPort: number;
  nodeId?: string;
}

export interface DeploymentView {
  id: string;
  projectId: string;
  state: DeploymentState;
  health: HealthStatus;
  port: number | null;
  pid: number | null;
  containerId: string | null;
  urls: DeploymentURLs | null;
  error: { code: string; message: string; causes: string[]; suggestions: string[] } | null;
  restartCount: number;
  startedAt: number | null;
  liveAt: number | null;
  warnings?: string[];
  metrics?: { cpu: number; memoryBytes: number; uptimeMs: number } | null;
  appPort?: number | null;
  runtime?: string | null;
  command?: string | null;
  name?: string;
  access?: (AccessConfig & { active: number; managed: boolean }) | null;
  hostingSession?: HostingSessionView | null;
}

export interface HostingSessionView {
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
  status: string;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export interface Plan {
  best: DetectionResult | null;
  candidates: DetectionResult[];
  ambiguous?: boolean;
  project: ProjectDefinition | null;
  packageManager?: string | null;
  capabilities?: RuntimeCapabilities;
  sharePort?: number | null;
  shareUrl?: string | null;
  running?: string | null;
  interfaces: NetworkInterfaceInfo[];
  network: NetworkInterfaceInfo | null;
  error?: { code: string; message: string; causes: string[]; suggestions: string[] };
}

export interface ClientsView {
  projectId: string;
  name: string;
  shareUrl: string | null;
  managed: boolean;
  access: AccessConfig | null;
  active: number;
  limit: number;
  sessions: ClientSession[];
  blocked: string[];
  invites: InviteLink[];
  retentionMs: number;
}

export interface NetworkView {
  primary: NetworkInterfaceInfo | null;
  interfaces: NetworkInterfaceInfo[];
  discovery: { enabled: boolean; providers: Array<{ name: string; ok: boolean; error?: string }>; nodes: number; online: number };
  node: RynkNode | null;
  proxy: { port: number };
}

export type AppView = RynkApp & { node: { nodeId: string; name: string; address: string; status: string; self: boolean } };

export interface ProjectView {
  id: string;
  name: string;
  root: string;
  language: string | null;
  framework: string | null;
  runtime: string;
  definition: ProjectDefinition;
  packageManager?: string | null;
  capabilities?: RuntimeCapabilities;
  deployment: DeploymentView | null;
}

export interface EventMessage {
  type: string;
  timestamp: number;
  payload: Record<string, unknown> & { projectId?: string; deploymentId?: string; entry?: LogEntry };
}

export function readDaemonState(file = paths.daemonState()): DaemonState | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

/** Typed client for the local Rynk daemon API. */
export class RynkClient {
  constructor(private readonly state: DaemonState) {}

  static fromDisk(): RynkClient | null {
    const s = readDaemonState();
    return s ? new RynkClient(s) : null;
  }

  get baseUrl() {
    return `http://${this.state.host}:${this.state.port}`;
  }

  get daemon() {
    return this.state;
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { authorization: `Bearer ${this.state.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new RynkError("DAEMON_UNREACHABLE", "The Rynk daemon isn't responding.", { cause: e, suggestions: ["rynk daemon restart", "rynk doctor"] });
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      if (res.status === 401) throw new RynkError("DAEMON_UNAUTHORIZED", "The daemon rejected Rynk's credentials.", { suggestions: ["rynk daemon restart"] });
      const err = (data?.error ?? {}) as { code?: string; message?: string; causes?: string[]; suggestions?: string[]; details?: Record<string, unknown> };
      throw new RynkError((err.code as never) ?? "INTERNAL", err.message ?? `HTTP ${res.status}`, { causes: err.causes ?? [], suggestions: err.suggestions ?? [], details: err.details ?? {} });
    }
    return data as T;
  }

  health() {
    return this.request<{ ok: boolean; version: string; pid: number }>("GET", "/api/health", undefined, 2000);
  }
  info() {
    return this.request<Record<string, unknown>>("GET", "/api/info");
  }
  projects() {
    return this.request<ProjectView[]>("GET", "/api/projects");
  }
  project(idOrName: string) {
    return this.request<ProjectView>("GET", `/api/projects/${encodeURIComponent(idOrName)}`);
  }
  deploy(req: StartRequest & { foreground?: boolean }) {
    return this.request<{ deploymentId: string; projectId: string; existing?: boolean }>("POST", "/api/deployments", req, 30_000);
  }
  stop(id: string) {
    return this.request<DeploymentView>("POST", `/api/projects/${encodeURIComponent(id)}/stop`, {}, 30_000);
  }
  restart(id: string) {
    return this.request<{ deploymentId: string }>("POST", `/api/projects/${encodeURIComponent(id)}/restart`, {}, 30_000);
  }
  remove(id: string) {
    return this.request<{ ok: true }>("DELETE", `/api/projects/${encodeURIComponent(id)}`);
  }
  logs(id: string, limit = 200, since?: number) {
    return this.request<LogEntry[]>("GET", `/api/projects/${encodeURIComponent(id)}/logs?limit=${limit}${since ? `&since=${since}` : ""}`);
  }
  hostingSessions(projectId?: string, limit = 50) {
    return this.request<HostingSessionView[]>("GET", `/api/hosting-sessions?limit=${limit}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`);
  }
  share(id: string, opts: { public?: boolean; provider?: string } = {}) {
    return this.request<{ url: string; provider: string; urls: DeploymentURLs }>("POST", `/api/projects/${encodeURIComponent(id)}/share`, opts, 45_000);
  }
  unshare(id: string) {
    return this.request<{ ok: true }>("DELETE", `/api/projects/${encodeURIComponent(id)}/share`);
  }
  detect(root: string) {
    return this.plan(root);
  }
  /** What Rynk would do in a directory. Nothing is started or reserved. */
  plan(root: string, opts: Record<string, string | number | undefined> = {}) {
    const q = new URLSearchParams({ root });
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== "") q.set(k, String(v));
    return this.request<Plan>("GET", `/api/plan?${q}`);
  }
  network() {
    return this.request<NetworkView>("GET", "/api/network");
  }
  nodes() {
    return this.request<RynkNode[]>("GET", "/api/nodes");
  }
  refreshNodes() {
    return this.request<RynkNode[]>("POST", "/api/nodes/refresh", {}, 10_000);
  }
  apps() {
    return this.request<AppView[]>("GET", "/api/apps");
  }
  ports() {
    return this.request<{ proxy: number; node: number | null; apps: Array<{ projectId: string; name: string; state: string; sharePort: number | null; appPort: number | null; bind: string | null; managed: boolean }> }>("GET", "/api/ports");
  }
  clients(id: string) {
    return this.request<ClientsView>("GET", `/api/projects/${encodeURIComponent(id)}/clients`);
  }
  disconnect(id: string, sessionId: string, block = false) {
    return this.request<ClientSession>("POST", `/api/projects/${encodeURIComponent(id)}/clients/${encodeURIComponent(sessionId)}/disconnect`, { block });
  }
  unblock(id: string, address: string) {
    return this.request<{ ok: boolean }>("POST", `/api/projects/${encodeURIComponent(id)}/unblock`, { address });
  }
  setAccess(id: string, patch: Partial<Pick<AccessConfig, "maxUsers" | "mode" | "advertise">>) {
    return this.request<AccessConfig>("PATCH", `/api/projects/${encodeURIComponent(id)}/access`, patch);
  }
  invite(id: string, opts: { ttlMs?: number; maxUses?: number } = {}) {
    return this.request<InviteLink & { url: string }>("POST", `/api/projects/${encodeURIComponent(id)}/invites`, opts);
  }
  revokeInvite(id: string, inviteId: string) {
    return this.request<{ ok: true }>("DELETE", `/api/projects/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`);
  }
  lanCheck(id: string) {
    return this.request<{ ok: boolean; address?: string; port?: number; error?: string; status?: number; reason?: string }>("GET", `/api/projects/${encodeURIComponent(id)}/lan-check`);
  }
  routes() {
    return this.request<unknown[]>("GET", "/api/routes");
  }
  devices() {
    return this.request<unknown[]>("GET", "/api/devices");
  }
  shutdown() {
    return this.request<{ ok: true }>("POST", "/api/shutdown", {});
  }

  /**
   * Subscribe to realtime events. With `lease`, the daemon stops that
   * deployment when this connection drops (foreground mode semantics).
   */
  events(opts: { projectId?: string; lease?: string; onEvent: (e: EventMessage) => void; onClose?: () => void }): { close(): void; ready: Promise<void> } {
    const q = new URLSearchParams();
    if (opts.projectId) q.set("projectId", opts.projectId);
    if (opts.lease) q.set("lease", opts.lease);
    const ws = new WebSocket(`ws://${this.state.host}:${this.state.port}/api/events?${q}`, { headers: { authorization: `Bearer ${this.state.token}` } });
    const ready = new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("message", (d) => {
      try {
        opts.onEvent(JSON.parse(String(d)) as EventMessage);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on("close", () => opts.onClose?.());
    return { close: () => ws.close(), ready };
  }
}
