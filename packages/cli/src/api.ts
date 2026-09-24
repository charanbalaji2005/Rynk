import path from "node:path";
import { RynkError, type ClientSession, type DeploymentURLs, type InviteLink, type StartRequest } from "@rynk/core";
import type { AppView, ClientsView, DeploymentView, NetworkView, Plan, ProjectView, RynkClient } from "@rynk/sdk";
import type { RynkNode } from "@rynk/core";
import { ensureDaemon } from "./daemon-control.js";

export interface HostOptions extends Omit<StartRequest, "root"> {
  /** Resolve only once the app is healthy (default true). */
  wait?: boolean;
}

/** A project hosted through the programmatic API. */
export class HostedApp {
  constructor(private readonly rynk: Rynk, readonly projectId: string, readonly deployment: DeploymentView) {}

  /** The link to share (public tunnel, else LAN, else local). */
  get url(): string | undefined {
    const u = this.deployment.urls;
    return u?.public ?? u?.network ?? u?.local;
  }
  get urls(): DeploymentURLs | null {
    return this.deployment.urls;
  }
  get port(): number | null {
    return this.deployment.port;
  }

  stop() {
    return this.rynk.stop(this.projectId);
  }
  restart() {
    return this.rynk.client.restart(this.projectId);
  }
  clients(): Promise<ClientSession[]> {
    return this.rynk.clients(this.projectId).then((v) => v.sessions);
  }
  setLimit(maxUsers: number) {
    return this.rynk.client.setAccess(this.projectId, { maxUsers });
  }
  invite(opts: { ttlMs?: number; maxUses?: number } = {}): Promise<InviteLink & { url: string }> {
    return this.rynk.client.invite(this.projectId, opts);
  }
  disconnect(sessionId: string, block = false) {
    return this.rynk.client.disconnect(this.projectId, sessionId, block);
  }
}

/**
 * Programmatic access to Rynk. The daemon is started on demand, exactly like
 * the CLI does.
 *
 *   import { Rynk } from "rynk";
 *   const rynk = await Rynk.connect();
 *   const app = await rynk.host("./my-app", { maxUsers: 10 });
 *   console.log(app.url);
 */
export class Rynk {
  private constructor(readonly client: RynkClient) {}

  static async connect(): Promise<Rynk> {
    return new Rynk(await ensureDaemon({ quiet: true }));
  }

  /** Host a directory in the background and (by default) wait until it's live. */
  async host(dir: string, options: HostOptions = {}): Promise<HostedApp> {
    const { wait = true, ...rest } = options;
    const res = await this.client.request<{ ok?: boolean; projectId: string; deploymentId: string; error?: { code: string; message: string; causes: string[]; suggestions: string[] }; deployment?: DeploymentView }>(
      "POST", "/api/deployments", { ...rest, root: path.resolve(dir), foreground: false, wait }, 15 * 60_000,
    );
    if (res.ok === false && res.error) throw new RynkError(res.error.code as never, res.error.message, { causes: res.error.causes, suggestions: res.error.suggestions });
    const dep = res.deployment ?? (await this.client.request<DeploymentView>("GET", `/api/deployments/${res.deploymentId}`));
    return new HostedApp(this, res.projectId, dep);
  }

  plan(dir: string): Promise<Plan> {
    return this.client.plan(path.resolve(dir));
  }
  status(project: string): Promise<ProjectView> {
    return this.client.project(project);
  }
  projects(): Promise<ProjectView[]> {
    return this.client.projects();
  }
  stop(project: string) {
    return this.client.stop(project);
  }
  clients(project: string): Promise<ClientsView> {
    return this.client.clients(project);
  }
  apps(): Promise<AppView[]> {
    return this.client.apps();
  }
  nodes(): Promise<RynkNode[]> {
    return this.client.refreshNodes().catch(() => this.client.nodes());
  }
  network(): Promise<NetworkView> {
    return this.client.network();
  }
}
