import fs from "node:fs";
import path from "node:path";
import {
  assertTransition,
  canonicalPath,
  isTerminal,
  newId,
  projectIdFor,
  RynkError,
  sleep,
  STAGE_LABELS,
  type AccessConfig,
  type DeploymentState,
  type DeploymentURLs,
  type HealthStatus,
  type InviteLink,
  type ProjectDefinition,
  type RynkApp,
  type StartRequest,
} from "@rynk/core";
import { AccessGateway } from "@rynk/access";
import { loadRynkYaml, resolveProject, type RynkYaml } from "@rynk/config";
import type { DetectorRegistry } from "@rynk/detector";
import type { EventBus } from "@rynk/events";
import type { Exposure, ExposureRegistry } from "@rynk/exposure";
import { HealthMonitor, httpProbe, tcpProbe, waitForHealthy } from "@rynk/health";
import type { Logger } from "@rynk/logger";
import { buildUrls, primaryInterface, type NetworkWatcher } from "@rynk/network";
import { isListening, isPortFree, parsePortFromOutput, type PortAllocator } from "@rynk/ports";
import { killTree, verifyProcess } from "@rynk/process";
import type { ProxyProvider, ProxyRoute } from "@rynk/proxy";
import { backoffDelay, type RuntimeInstance, type RuntimeRegistry } from "@rynk/runtime";
import { explainOutput } from "./hints.js";
import type { LogManager } from "./logs.js";
import type { PluginManager } from "./plugins.js";
import type { DeploymentRow, HostingSessionRow, HostingStatus, Store } from "./store.js";

export interface EngineDeps {
  store: Store;
  bus: EventBus;
  logs: LogManager;
  detectors: DetectorRegistry;
  runtimes: RuntimeRegistry;
  /** User-facing share ports (sticky per project). */
  ports: PortAllocator;
  /** Internal loopback ports the apps themselves listen on. */
  appPorts: PortAllocator;
  proxy: ProxyProvider;
  network: NetworkWatcher;
  exposures: ExposureRegistry;
  plugins: PluginManager;
  logger: Logger;
  /** This machine's Rynk node id (recorded on hosting sessions). */
  nodeId?: string;
}

export type DeployRequest = StartRequest & { foreground?: boolean };

/** In-memory state for an active deployment. The DB mirrors the durable parts. */
interface Live {
  id: string;
  projectId: string;
  root: string;
  request: DeployRequest;
  state: DeploymentState;
  health: HealthStatus;
  project?: ProjectDefinition;
  instance?: RuntimeInstance;
  /** Internal port reserved for the app. */
  allocatedPort?: number;
  /** Where the app actually listens (usually allocatedPort). */
  port?: number;
  /** The port people connect to (the access gateway). */
  sharePort?: number;
  probeHost: string;
  portHint?: number;
  urls?: DeploymentURLs;
  route?: ProxyRoute;
  gateway?: AccessGateway;
  exposure?: Exposure;
  monitor?: HealthMonitor;
  abort: AbortController;
  stopping: boolean;
  relaunching: boolean;
  persisted: boolean;
  restartAttempts: number;
  restartCount: number;
  warnings: string[];
  stableTimer?: NodeJS.Timeout;
  lastMetrics?: { cpu: number; memoryBytes: number; uptimeMs: number } | null;
  error?: ReturnType<RynkError["toJSON"]>;
  startedAt?: number;
  liveAt?: number;
  hosting?: HostingSessionRow;
}

const LOOPBACK = "127.0.0.1";

export class DeploymentEngine {
  private live = new Map<string, Live>(); // projectId → live deployment
  private metricsTimer: NodeJS.Timeout | undefined;
  private metricsTick = 0;

  constructor(private readonly d: EngineDeps) {
    d.bus.on("network.changed", () => void this.refreshUrls());
  }

  // ── lifecycle API ─────────────────────────────────────────

  async deploy(req: DeployRequest): Promise<{ deploymentId: string; projectId: string; existing?: boolean }> {
    const root = canonicalPath(req.root);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new RynkError("NOT_FOUND", `Directory not found: ${root}`);
    }
    const projectId = projectIdFor(root);
    const current = this.live.get(projectId);
    if (current && !isTerminal(current.state)) return { deploymentId: current.id, projectId, existing: true };

    const ld: Live = {
      id: newId("dep_"),
      projectId,
      root,
      request: { ...req, root },
      state: "CREATED",
      health: "UNKNOWN",
      probeHost: LOOPBACK,
      abort: new AbortController(),
      stopping: false,
      relaunching: false,
      persisted: false,
      restartAttempts: 0,
      restartCount: 0,
      warnings: [],
    };
    this.live.set(projectId, ld);
    this.d.bus.emit("deployment.created", { deploymentId: ld.id, projectId });
    void this.run(ld);
    return { deploymentId: ld.id, projectId };
  }

  async stop(idOrName: string, opts: { keepDesired?: boolean } = {}): Promise<DeploymentRow | undefined> {
    const ld = await this.find(idOrName);
    if (!ld) {
      const p = await this.d.store.getProject(idOrName);
      if (!p) throw new RynkError("NOT_FOUND", `No project named "${idOrName}".`, { suggestions: ["rynk projects"] });
      const row = await this.d.store.latestDeployment(p.id);
      if (row && !opts.keepDesired) await this.d.store.updateDeployment(row.id, { desired: "stopped" });
      return row;
    }
    await this.teardown(ld, opts.keepDesired ? "running" : "stopped");
    return this.d.store.getDeployment(ld.id);
  }

  async stopDeployment(deploymentId: string) {
    const ld = [...this.live.values()].find((l) => l.id === deploymentId);
    if (ld) await this.teardown(ld, "stopped");
  }

  /**
   * Restart a project. A live deployment is restarted *in place*: same
   * deployment, same share link, clients keep their sessions and see a short
   * "restarting" page. Anything else is redeployed from its saved settings.
   */
  async restart(idOrName: string): Promise<{ deploymentId: string; projectId: string; inPlace?: boolean }> {
    const ld = await this.find(idOrName);
    if (ld && ld.project && (ld.state === "LIVE" || ld.state === "RESTARTING")) {
      void this.relaunch(ld, "Restarting (requested)");
      return { deploymentId: ld.id, projectId: ld.projectId, inPlace: true };
    }
    const p = ld ? null : await this.d.store.getProject(idOrName);
    const root = ld?.root ?? p?.root;
    if (!root) throw new RynkError("NOT_FOUND", `No project named "${idOrName}".`);
    const request = ld?.request ?? (await this.d.store.getSetting<DeployRequest>(`request:${p!.id}`)) ?? { root };
    if (ld) await this.teardown(ld, "running");
    return this.deploy({ ...request, install: false, foreground: false });
  }

  async remove(idOrName: string) {
    const p = await this.d.store.getProject(idOrName);
    if (!p) throw new RynkError("NOT_FOUND", `No project named "${idOrName}".`);
    const ld = this.live.get(p.id);
    if (ld) await this.teardown(ld, "stopped");
    await this.d.store.deleteProject(p.id);
    this.d.logs.clear(p.id);
  }

  // ── sharing & access control ─────────────────────────────

  async share(idOrName: string, opts: { public?: boolean; provider?: string }) {
    const ld = await this.requireLive(idOrName);
    if (!opts.public) return { url: ld.urls!.network ?? ld.urls!.local, provider: "lan", urls: ld.urls! };
    const provider = opts.provider ? this.d.exposures.get(opts.provider) : this.d.exposures.defaultPublic();
    // The tunnel points at the gateway, so limits and invites apply to internet visitors too.
    const exposure = await provider.create({ projectId: ld.projectId, name: ld.project!.name, port: ld.sharePort!, host: LOOPBACK });
    ld.exposure = exposure;
    ld.urls = { ...ld.urls!, public: exposure.url };
    await this.persist(ld, { urls: ld.urls });
    this.d.logs.system(ld.projectId, ld.id, `Public URL (${provider.name}): ${exposure.url}`, "warn");
    this.d.bus.emit("exposure.created", { projectId: ld.projectId, url: exposure.url, provider: provider.name });
    this.d.bus.emit("urls.updated", { deploymentId: ld.id, projectId: ld.projectId, urls: ld.urls });
    return { url: exposure.url, provider: provider.name, urls: ld.urls };
  }

  async unshare(idOrName: string) {
    const ld = await this.find(idOrName);
    if (!ld?.exposure) return;
    await this.d.exposures.get(ld.exposure.provider).destroy(ld.exposure.id);
    this.d.bus.emit("exposure.closed", { projectId: ld.projectId, provider: ld.exposure.provider });
    ld.exposure = undefined;
    if (ld.urls) {
      delete ld.urls.public;
      await this.persist(ld, { urls: ld.urls });
      this.d.bus.emit("urls.updated", { deploymentId: ld.id, projectId: ld.projectId, urls: ld.urls });
    }
  }

  async clients(idOrName: string) {
    const ld = await this.requireLive(idOrName, { allowStarting: true });
    const g = ld.gateway;
    return {
      projectId: ld.projectId,
      name: ld.project?.name ?? path.basename(ld.root),
      shareUrl: ld.urls?.network ?? ld.urls?.local ?? null,
      managed: Boolean(g),
      access: ld.project?.access ?? null,
      active: g ? g.stats().active : 0,
      limit: ld.project?.access.maxUsers ?? 0,
      sessions: g ? g.sessions() : [],
      blocked: g ? g.table.blockedAddresses() : [],
      retentionMs: ld.project?.access.clientRetentionMs ?? 600_000,
      invites: g ? g.table.listInvites() : [],
    };
  }

  async disconnect(idOrName: string, sessionId: string, opts: { block?: boolean } = {}) {
    const ld = await this.requireLive(idOrName);
    const s = ld.gateway?.table.end(sessionId, opts);
    if (!s) throw new RynkError("NOT_FOUND", `No client session ${sessionId}.`, { suggestions: [`rynk clients ${ld.project!.name}`] });
    this.d.logs.system(ld.projectId, ld.id, `Disconnected client ${s.clientAddress}${opts.block ? " and blocked the address" : ""}`);
    return s;
  }

  async unblock(idOrName: string, address: string) {
    const ld = await this.requireLive(idOrName);
    return { ok: ld.gateway?.table.unblock(address) ?? false };
  }

  async updateAccess(idOrName: string, patch: Partial<Pick<AccessConfig, "maxUsers" | "mode" | "advertise">>) {
    const ld = await this.requireLive(idOrName, { allowStarting: true });
    const p = ld.project!;
    if (patch.mode === "protected" && p.access.mode !== "protected" && ld.gateway) {
      // Don't lock out people who are already using the app.
      for (const s of ld.gateway.sessions()) {
        const internal = ld.gateway.table.get(s.sessionId);
        if (internal) internal.invited = true;
      }
    }
    p.access = { ...p.access, ...patch };
    ld.gateway?.setPolicy(p.access);
    ld.request = {
      ...ld.request,
      ...(patch.maxUsers !== undefined ? { maxUsers: patch.maxUsers } : {}),
      ...(patch.mode ? { protected: patch.mode === "protected" } : {}),
      ...(patch.advertise !== undefined ? { advertise: patch.advertise } : {}),
    };
    await this.d.store.setSetting(`request:${ld.projectId}`, { ...ld.request, install: undefined });
    if (p.access.maxUsers && ld.project?.runtime === "compose") this.warn(ld, "User limits aren't enforced for Compose projects (their ports are published directly).");
    this.d.logs.system(ld.projectId, ld.id, `Access: ${p.access.mode}, max users ${p.access.maxUsers || "unlimited"}`);
    await this.hostingUpdate(ld, { maxUsers: p.access.maxUsers, accessMode: p.access.mode });
    this.d.bus.emit("access.updated", { projectId: ld.projectId, deploymentId: ld.id, access: p.access });
    return p.access;
  }

  async createInvite(idOrName: string, ttlMs: number, maxUses: number): Promise<InviteLink & { url: string }> {
    const ld = await this.requireLive(idOrName);
    if (!ld.gateway) throw new RynkError("EXPOSURE_FAILED", "Invite links need the Rynk access gateway, which Compose projects don't use.");
    if (ld.project!.access.mode !== "protected") await this.updateAccess(idOrName, { mode: "protected" });
    const { invite, token } = ld.gateway.table.createInvite(ttlMs, maxUses);
    const base = ld.urls?.public ?? ld.urls?.network ?? ld.urls!.local;
    const url = `${base.replace(/\/$/, "")}/?rynk_access=${token}`;
    this.d.logs.system(ld.projectId, ld.id, `Invite ${invite.id} created (expires ${new Date(invite.expiresAt).toLocaleString()}, ${maxUses} uses)`);
    return { ...invite, url };
  }

  async revokeInvite(idOrName: string, inviteId: string) {
    const ld = await this.requireLive(idOrName);
    if (!ld.gateway?.table.revokeInvite(inviteId)) throw new RynkError("NOT_FOUND", `No invite ${inviteId}.`);
    return { ok: true };
  }

  /** Apps this node advertises to other Rynk nodes (public fields only). */
  publicApps(): RynkApp[] {
    return [...this.live.values()]
      .filter((l) => l.state === "LIVE" && l.project && l.urls?.network && l.project.exposure !== "local" && l.project.access.advertise)
      .map((l) => ({
        id: l.projectId,
        name: l.project!.name,
        ...(l.project!.framework ? { framework: l.project!.framework } : {}),
        runtime: l.project!.runtime,
        url: l.urls!.network!,
        port: l.sharePort!,
        status: l.state,
        access: l.project!.access.mode,
      }));
  }

  ports() {
    return [...this.live.values()]
      .filter((l) => !isTerminal(l.state))
      .map((l) => ({
        projectId: l.projectId,
        name: l.project?.name ?? path.basename(l.root),
        state: l.state,
        sharePort: l.sharePort ?? null,
        appPort: l.port ?? l.allocatedPort ?? null,
        bind: l.gateway?.host ?? null,
        managed: Boolean(l.gateway),
      }));
  }

  // ── planning & views ─────────────────────────────────────

  /** Dry run: what would Rynk do in this directory? Nothing is started or reserved. */
  async plan(root: string, cli: DeployRequest | { root: string } = { root }) {
    const abs = canonicalPath(root);
    const yaml = loadRynkYaml(abs)?.config ?? null;
    await this.d.plugins.loadForProject(abs, yaml);
    const req = cli as DeployRequest;
    const report = await this.d.detectors.detect(abs, req.runtime && req.runtime !== "auto" ? { prefer: req.runtime } : {});
    const project = resolveProject({ root: abs, cli: this.cliOverrides(req), yaml, detection: report.best, packageName: this.packageName(abs) });
    const running = this.live.get(project.id);
    const sharePort =
      running?.sharePort ??
      (project.runtime === "compose" ? (project.port ?? project.defaultPort ?? null) : await this.d.ports.peek(project.id, project.port ?? project.defaultPort).catch(() => null));
    return { report, project, yaml, sharePort, running: running ? running.state : null };
  }

  view(row: DeploymentRow) {
    const ld = [...this.live.values()].find((l) => l.id === row.id);
    return {
      id: row.id,
      projectId: row.projectId,
      state: ld?.state ?? row.state,
      health: ld?.health ?? row.health,
      port: ld?.sharePort ?? row.port,
      appPort: ld?.port ?? null,
      pid: ld ? (ld.instance?.alive() ? (ld.instance.pid ?? null) : null) : row.pid,
      containerId: ld?.instance?.containerId ?? row.containerId,
      urls: ld?.urls ?? row.urls,
      error: ld?.error ?? row.error,
      restartCount: ld?.restartCount ?? row.restartCount,
      startedAt: ld?.startedAt ?? row.startedAt,
      liveAt: ld?.liveAt ?? row.liveAt,
      warnings: ld?.warnings ?? [],
      metrics: ld?.lastMetrics ?? null,
      runtime: ld?.instance?.kind ?? null,
      command: ld?.instance?.command.display ?? null,
      access: ld ? this.accessSummary(ld) : null,
      hostingSession: ld?.hosting ?? null,
    };
  }

  /** View of an in-memory deployment that may not be persisted yet. */
  snapshot(deploymentId: string) {
    const ld = [...this.live.values()].find((l) => l.id === deploymentId);
    if (!ld) return undefined;
    return {
      id: ld.id,
      projectId: ld.projectId,
      name: ld.project?.name ?? path.basename(ld.root),
      state: ld.state,
      health: ld.health,
      port: ld.sharePort ?? null,
      appPort: ld.port ?? null,
      pid: ld.instance?.alive() ? (ld.instance.pid ?? null) : null,
      containerId: ld.instance?.containerId ?? null,
      urls: ld.urls ?? null,
      error: ld.error ?? null,
      restartCount: ld.restartCount,
      startedAt: ld.startedAt ?? null,
      liveAt: ld.liveAt ?? null,
      warnings: ld.warnings,
      metrics: ld.lastMetrics ?? null,
      runtime: ld.instance?.kind ?? ld.project?.runtime ?? null,
      command: ld.instance?.command.display ?? ld.project?.start.display ?? null,
      access: this.accessSummary(ld),
      hostingSession: ld.hosting ?? null,
    };
  }

  private accessSummary(ld: Live) {
    if (!ld.project) return null;
    return { ...ld.project.access, active: ld.gateway?.stats().active ?? 0, managed: Boolean(ld.gateway) };
  }

  liveView(projectId: string) {
    return this.live.get(projectId);
  }

  liveIds() {
    return [...this.live.values()].map((l) => ({ id: l.id, projectId: l.projectId, foreground: Boolean(l.request.foreground) }));
  }

  activeCount() {
    return [...this.live.values()].filter((l) => !isTerminal(l.state)).length;
  }

  /** Bring back deployments that were running before the daemon stopped. */
  async restore() {
    for (const row of await this.d.store.desiredRunning()) {
      const p = await this.d.store.getProject(row.projectId);
      if (!p || !fs.existsSync(p.root)) continue;
      const request = (await this.d.store.getSetting<DeployRequest>(`request:${p.id}`)) ?? { root: p.root };
      if (request.foreground) {
        await this.d.store.updateDeployment(row.id, { state: "STOPPED", desired: "stopped" });
        continue;
      }
      // The daemon may have died without stopping its children; reap the orphan first.
      if (row.pid && row.startedAt && row.state !== "STOPPED") {
        const expect = { startedAt: row.startedAt, command: row.command ?? null, cwd: row.cwd ?? null };
        const check = await verifyProcess(row.pid, expect);
        if (check.ok) {
          this.d.logger.warn(`Reaping orphaned process ${row.pid} of ${p.name}`);
          killTree(row.pid, "SIGTERM");
          await sleep(1500);
          if ((await verifyProcess(row.pid, expect)).ok) killTree(row.pid, "SIGKILL");
        } else {
          this.d.logger.info(`Not touching PID ${row.pid} recorded for ${p.name}: ${check.reason}`);
        }
      }
      this.d.logger.info(`Restoring ${p.name}`);
      await this.d.store.updateDeployment(row.id, { state: "STOPPED" });
      await this.deploy({ ...request, install: false }).catch((e) => this.d.logger.error(`Restore of ${p.name} failed: ${(e as Error).message}`));
    }
  }

  async shutdown() {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    await Promise.allSettled([...this.live.values()].map((l) => this.teardown(l, "running")));
  }

  startMetrics(intervalMs = 5000) {
    this.metricsTimer = setInterval(() => void this.collectMetrics(), intervalMs);
    this.metricsTimer.unref();
  }

  // ── pipeline ──────────────────────────────────────────────

  private async run(ld: Live) {
    const req = ld.request;
    try {
      await this.transition(ld, "DISCOVERING");
      const yamlFile = loadRynkYaml(ld.root);
      const yaml: RynkYaml | null = yamlFile?.config ?? null;
      if (yamlFile) this.say(ld, `Using ${path.basename(yamlFile.file)}`);
      await this.d.plugins.loadForProject(ld.root, yaml);
      const report = await this.d.detectors.detect(ld.root, req.runtime && req.runtime !== "auto" ? { prefer: req.runtime } : {});
      if (report.best) {
        this.say(ld, `Detected ${report.best.framework ?? report.best.language} (${report.best.evidence.slice(0, 3).join(", ")})`);
        for (const w of report.best.warnings ?? []) this.warn(ld, w);
      }

      await this.transition(ld, "RESOLVING");
      const project = resolveProject({ root: ld.root, cli: this.cliOverrides(req), yaml, detection: report.best, packageName: this.packageName(ld.root) });
      ld.project = project;
      await this.d.store.upsertProject(project);
      await this.d.store.insertDeployment(ld.id, ld.projectId, ld.state);
      ld.persisted = true;
      await this.d.store.setSetting(`request:${ld.projectId}`, { ...req, install: undefined });
      this.d.bus.emit("project.detected", { projectId: project.id, name: project.name, language: project.language, ...(project.framework ? { framework: project.framework } : {}) });
      this.say(ld, `Runtime: ${project.runtime} · start: ${project.start.display}`);

      await this.transition(ld, "PREPARING");
      const adapter = this.d.runtimes.get(project.runtime);
      const av = await adapter.available(project);
      if (!av.ok) {
        throw new RynkError("RUNTIME_UNAVAILABLE", av.reason ?? `The ${project.runtime} runtime is not available.`, {
          suggestions: ["rynk doctor", ...(project.runtime === "docker" ? ["Start Docker Desktop"] : [])],
        });
      }
      const ctx = this.runtimeContext(ld, 0);
      if (project.install?.length && req.install !== false) {
        await this.transition(ld, "INSTALLING");
        await adapter.install(project, ctx);
      }
      if (project.build?.length || project.runtime === "docker") {
        await this.transition(ld, "BUILDING");
        await adapter.build(project, ctx);
      }

      await this.transition(ld, "ALLOCATING");
      ld.allocatedPort = await this.allocateAppPort(ld, project);
      this.d.bus.emit("port.allocated", { projectId: ld.projectId, port: ld.allocatedPort });

      await this.launch(ld);
      if (req.public || project.exposure === "public") {
        await this.share(ld.projectId, { public: true }).catch((e) => this.warn(ld, `Public link not created: ${(e as Error).message}`));
      }
    } catch (e) {
      await this.fail(ld, e);
    }
  }

  /** STARTING → HEALTH_CHECKING → REGISTERING → EXPOSING → LIVE. Reused by restarts. */
  private async launch(ld: Live) {
    const project = ld.project!;
    const adapter = this.d.runtimes.get(project.runtime);
    await this.transition(ld, "STARTING");
    ld.portHint = undefined;
    ld.port = undefined;
    // Remember which fallback ports were already taken so discovery can't mistake them for this app.
    const busyBefore = new Set<number>();
    if (project.defaultPort && project.defaultPort !== ld.allocatedPort && (await isListening(project.defaultPort, LOOPBACK, 200))) busyBefore.add(project.defaultPort);
    const instance = await adapter.start(project, this.runtimeContext(ld, ld.allocatedPort!));
    ld.instance = instance;
    ld.startedAt = instance.startedAt;
    await this.persist(ld, { pid: instance.pid ?? null, startedAt: instance.startedAt, containerId: instance.containerId ?? null, command: instance.command.display, cwd: project.root });
    this.d.logs.bind(ld.id, { ...(instance.pid ? { pid: instance.pid } : {}) });
    this.d.bus.emit("runtime.started", { deploymentId: ld.id, projectId: ld.projectId, ...(instance.pid ? { pid: instance.pid } : {}), ...(instance.containerId ? { containerId: instance.containerId } : {}) });
    instance.exited.then((exit) => void this.onExit(ld, instance, exit.code, exit.signal));

    await this.transition(ld, "HEALTH_CHECKING");
    this.setHealth(ld, "STARTING");
    const discovery = this.discoverPort(ld, instance, busyBefore);
    const result = await waitForHealthy(
      project.health,
      () => ({ host: ld.probeHost, port: ld.port ?? ld.allocatedPort!, isAlive: () => instance.alive() && !ld.stopping }),
      { signal: ld.abort.signal },
    );
    discovery.stop();
    if (ld.stopping) return;
    if (!result.ok) {
      if (!instance.alive()) {
        const tail = this.d.logs.lastOutput(ld.projectId, ld.id);
        const why = explainOutput(tail);
        throw new RynkError("PROCESS_EXITED", `${project.name} exited during startup (code ${(await instance.exited).code ?? "?"}).`, {
          causes: why.causes.length ? why.causes : tail.slice(-6),
          suggestions: [...why.suggestions, `rynk logs ${project.name}`, "rynk doctor"],
        });
      }
      await instance.stop(3000);
      throw new RynkError("HEALTH_CHECK_FAILED", `${project.name} started but never answered on port ${ld.port ?? ld.allocatedPort}.`, {
        causes: [
          "The application is listening on a different port.",
          "The application is still starting (slow build or JIT).",
          "The application isn't an HTTP server.",
          ...(result.error ? [`Last probe error: ${result.error}`] : []),
        ],
        suggestions: [`rynk start --port <port-your-app-uses>`, "Set health.type: tcp or a longer health.startupTimeout in rynk.yaml", `rynk logs ${project.name}`],
      });
    }
    ld.port = ld.port ?? ld.allocatedPort!;
    if (ld.port !== ld.allocatedPort) {
      await this.d.appPorts.adopt(ld.projectId, ld.port);
      this.say(ld, `App chose port ${ld.port} itself`);
    }
    this.setHealth(ld, "HEALTHY");

    await this.transition(ld, "REGISTERING");
    await this.transition(ld, "EXPOSING");
    await this.expose(ld);
    await this.persist(ld, { port: ld.sharePort ?? ld.port });

    await this.transition(ld, "LIVE");
    ld.gateway?.setAvailable(true);
    await this.hostingUpdate(ld, { status: "live" });
    ld.liveAt = Date.now();
    ld.error = undefined;
    await this.persist(ld, { liveAt: ld.liveAt, error: null, restartCount: ld.restartCount, urls: ld.urls! });
    this.d.bus.emit("deployment.completed", { deploymentId: ld.id, projectId: ld.projectId, urls: ld.urls! });

    ld.monitor = new HealthMonitor(project.health, () => ({ host: ld.probeHost, port: ld.port!, isAlive: () => instance.alive() }), (_from, to, r) => {
      this.setHealth(ld, to);
      void this.d.store.recordHealth(ld.id, to, r.latencyMs, r.error);
      if (to === "UNHEALTHY") this.warn(ld, `Health check failing: ${r.error ?? `HTTP ${r.status}`}`);
    }, { failureThreshold: 3, successThreshold: 2, gracePeriodMs: Math.min(30_000, project.health.intervalMs * 2) });
    ld.monitor.status = "HEALTHY";
    ld.monitor.start();
    ld.stableTimer = setTimeout(() => (ld.restartAttempts = 0), 60_000);
    ld.stableTimer.unref();
  }

  /**
   * Find where the app actually listens. Priority depends on whether we could
   * control the port. Checks IPv4 and IPv6 loopback. Never adopts a port
   * owned by another project, busy before we started, or our own share port.
   */
  private discoverPort(ld: Live, instance: RuntimeInstance, busyBefore: Set<number>) {
    let stopped = false;
    const project = ld.project!;
    const controllable = project.binding.portControllable || project.runtime === "docker" || project.runtime === "static";
    const ownedByOther = (p: number) => {
      const owner = this.d.ports.reservedBy(p) ?? this.d.appPorts.reservedBy(p);
      return owner !== undefined && owner !== ld.projectId;
    };
    const loop = async () => {
      while (!stopped && instance.alive() && !ld.stopping) {
        const candidates = [...new Set((controllable ? [ld.allocatedPort, ld.portHint] : [ld.portHint, ld.allocatedPort, project.defaultPort]).filter((p): p is number => !!p))]
          .filter((p) => p !== ld.sharePort && (p === ld.allocatedPort || (!busyBefore.has(p) && !ownedByOther(p))));
        found: for (const p of candidates) {
          for (const h of [LOOPBACK, "::1"]) {
            if (await isListening(p, h, 300)) {
              ld.port = p;
              ld.probeHost = h;
              break found;
            }
          }
        }
        await sleep(400);
      }
    };
    void loop();
    return { stop: () => (stopped = true) };
  }

  /** Put the access gateway in front of the app on the share port (or retarget it after a restart). */
  private async expose(ld: Live) {
    const p = ld.project!;
    const target = { host: ld.probeHost === "::1" ? "::1" : LOOPBACK, port: ld.port! };

    if (p.runtime === "compose") {
      ld.sharePort = ld.port;
      this.warn(ld, "[DIRECT / UNMANAGED] Compose service publishes port directly. Rynk access controls (maxUsers, client tracking, disconnect, invite tokens, rate limiting) do not apply to direct ports.");
    } else if (ld.gateway) {
      ld.gateway.setTarget(target);
    } else {
      const listenHost = this.bindHost(p);
      const preferred = p.port ?? p.defaultPort ?? (ld.port !== ld.allocatedPort ? undefined : 3000);
      let gateway: AccessGateway | undefined;
      for (let attempt = 0; attempt < 3 && !gateway; attempt++) {
        const sharePort = await this.d.ports.allocate(ld.projectId, preferred, p.port !== undefined && attempt === 0);
        const g = new AccessGateway({
          listenHost,
          listenPort: sharePort,
          target,
          policy: p.access,
          onSession: (e) => {
            this.d.bus.emit("access.session", { projectId: ld.projectId, deploymentId: ld.id, kind: e.kind, session: e.session, active: e.active, limit: e.limit });
            if (ld.hosting && e.active > ld.hosting.peakUsers) void this.hostingUpdate(ld, { peakUsers: e.active });
          },
          onDenied: (reason, clientAddress) => this.d.bus.emit("access.denied", { projectId: ld.projectId, deploymentId: ld.id, reason, clientAddress }),
        });
        g.setAvailable(false);
        try {
          await g.start();
          gateway = g;
          ld.sharePort = sharePort;
        } catch (e) {
          if (RynkError.from(e).code !== "PORT_UNAVAILABLE" || (p.port !== undefined && attempt === 0)) throw e;
          this.d.ports.release(ld.projectId);
        }
      }
      if (!gateway) throw new RynkError("PORT_UNAVAILABLE", "Couldn't open a share port for this project.", { suggestions: ["rynk ports", "rynk doctor"] });
      ld.gateway = gateway;
      if (p.defaultPort && ld.sharePort !== p.defaultPort && p.port === undefined) this.say(ld, `Port ${p.defaultPort} is busy — sharing on ${ld.sharePort}`);
    }

    // An app that ignores our loopback binding is reachable directly, bypassing the gateway.
    const primary = this.selectedInterface(ld);
    if (primary && ld.gateway && ld.port !== ld.sharePort && (await tcpProbe(primary.address, ld.port!, 800)).ok) {
      this.warn(ld, `The app itself also listens on the network (port ${ld.port}); visitors using that port bypass access limits.`);
    }

    const route: ProxyRoute = {
      id: `route_${ld.projectId}`,
      projectId: ld.projectId,
      name: p.name,
      pathPrefix: `/${p.name}`,
      hostnames: [`${p.name}.localhost`],
      targetHost: LOOPBACK,
      targetPort: ld.sharePort!,
      lan: false,
    };
    await this.d.proxy.register(route);
    await this.d.store.saveRoute(route);
    ld.route = route;
    this.d.bus.emit("route.created", { route });
    ld.urls = this.computeUrls(ld);

    if (!ld.hosting && ld.persisted) {
      const iface = this.selectedInterface(ld);
      ld.hosting = await this.d.store.createHostingSession({
        nodeId: this.d.nodeId ?? "local",
        projectId: ld.projectId,
        deploymentId: ld.id,
        projectName: p.name,
        hostAddress: p.exposure === "local" ? LOOPBACK : (iface?.address ?? null),
        internalPort: ld.port ?? null,
        sharePort: ld.sharePort ?? null,
        localUrl: ld.urls.local,
        shareUrl: ld.urls.network ?? ld.urls.local,
        exposure: p.exposure,
        accessMode: p.access.mode,
        maxUsers: p.access.maxUsers,
        status: "starting",
      });
      this.d.logs.bind(ld.id, { hostingSessionId: ld.hosting.id });
    } else if (ld.hosting) {
      await this.hostingUpdate(ld, { internalPort: ld.port ?? null, shareUrl: ld.urls.network ?? ld.urls.local });
    }

    // Is the share link reachable over the LAN address (not just loopback)?
    const lanIface = this.selectedInterface(ld);
    if (p.exposure !== "local" && lanIface && ld.gateway && ld.gateway.host === "0.0.0.0") {
      const r = await httpProbe(lanIface.address, ld.sharePort!, "/", 2000, { "x-rynk-probe": ld.gateway.probeToken });
      if (!r.ok) {
        this.warn(ld, `Application is healthy locally, but ${ld.urls.network} didn't answer over the LAN address. LAN access may be blocked by your OS firewall.`);
      }
    }
  }

  private async hostingUpdate(ld: Live, patch: Partial<Omit<HostingSessionRow, "id" | "createdAt">>) {
    if (!ld.hosting) return;
    Object.assign(ld.hosting, patch);
    await this.d.store.updateHostingSession(ld.hosting.id, patch).catch((e) => this.d.logger.error(`hosting session update failed: ${(e as Error).message}`));
  }

  /** Hosting session view for API consumers. */
  hostingSession(projectId: string) {
    return this.live.get(projectId)?.hosting;
  }

  private bindHost(p: ProjectDefinition): string {
    if (p.exposure === "local") return LOOPBACK;
    const h = p.host;
    return !h || h === "auto" || h === "0.0.0.0" || h === "::" ? "0.0.0.0" : h;
  }

  private selectedInterface(ld: Live) {
    const ifaces = this.d.network.current();
    const want = ld.request.network?.toLowerCase();
    if (want) {
      const hit = ifaces.find((i) => i.name.toLowerCase() === want || i.address === want);
      if (hit) return hit;
    }
    const bound = ld.gateway?.host;
    if (bound && bound !== "0.0.0.0" && bound !== LOOPBACK) return ifaces.find((i) => i.address === bound) ?? primaryInterface(ifaces);
    return primaryInterface(ifaces);
  }

  private computeUrls(ld: Live): DeploymentURLs {
    const p = ld.project!;
    const port = ld.sharePort ?? ld.port!;
    const ifaces = this.d.network.current();
    const chosen = this.selectedInterface(ld);
    const ordered = chosen ? [chosen, ...ifaces.filter((i) => i.address !== chosen.address)] : ifaces;
    const bound = ld.gateway?.host ?? "0.0.0.0";
    const usable = bound === "0.0.0.0" ? ordered : ordered.filter((i) => i.address === bound);
    const urls = buildUrls({ port, exposure: p.exposure, interfaces: usable, ...(ld.exposure ? { publicUrl: ld.exposure.url } : {}) });
    urls.proxy = `http://${p.name}.localhost:${this.d.proxy.port}/`;
    return urls;
  }

  private async refreshUrls() {
    for (const ld of this.live.values()) {
      if (ld.state !== "LIVE") continue;
      const before = ld.urls?.network;
      ld.urls = this.computeUrls(ld);
      await this.persist(ld, { urls: ld.urls });
      if (before !== ld.urls.network) {
        this.say(ld, `Network changed — share link is now ${ld.urls.network ?? ld.urls.local}`);
        await this.hostingUpdate(ld, { shareUrl: ld.urls.network ?? ld.urls.local, hostAddress: this.selectedInterface(ld)?.address ?? null });
      }
      this.d.bus.emit("urls.updated", { deploymentId: ld.id, projectId: ld.projectId, urls: ld.urls });
    }
  }

  private async allocateAppPort(ld: Live, p: ProjectDefinition): Promise<number> {
    if (p.runtime === "compose") {
      const port = p.port ?? p.defaultPort;
      if (!port) throw new RynkError("PORT_UNAVAILABLE", "The compose file doesn't publish any ports.", { suggestions: ['Add ports: ["3000:3000"] to your web service'] });
      if (!(await isPortFree(port))) throw new RynkError("PORT_UNAVAILABLE", `Port ${port} (from your compose file) is already in use.`);
      return port;
    }
    return this.d.appPorts.allocate(ld.projectId);
  }

  private runtimeContext(ld: Live, port: number) {
    const p = ld.project!;
    const userCommand = Boolean(ld.request.command) || p.source.includes("rynk.yaml");
    return {
      port,
      // Apps listen on loopback only; the gateway is what the network sees.
      host: p.runtime === "compose" ? p.host : LOOPBACK,
      origin: userCommand ? ("user" as const) : ("detector" as const),
      signal: ld.abort.signal,
      onLine: (line: string, stream: "stdout" | "stderr" | "system") => {
        this.d.logs.write(ld.projectId, ld.id, line, stream);
        if (stream !== "system" && !ld.portHint) {
          const hint = parsePortFromOutput(line);
          if (hint && hint !== ld.sharePort) ld.portHint = hint;
        }
      },
    };
  }

  // ── lifecycle internals ───────────────────────────────────

  private async relaunch(ld: Live, reason: string) {
    ld.relaunching = true;
    ld.monitor?.stop();
    if (ld.stableTimer) clearTimeout(ld.stableTimer);
    ld.gateway?.setAvailable(false);
    try {
      await this.transition(ld, "RESTARTING", reason);
      await this.hostingUpdate(ld, { status: "restarting" });
      this.d.bus.emit("runtime.restarted", { deploymentId: ld.id, projectId: ld.projectId, attempt: 0 });
      await ld.instance?.stop().catch(() => undefined);
      ld.relaunching = false;
      ld.restartCount++;
      await this.launch(ld);
    } catch (e) {
      ld.relaunching = false;
      await this.fail(ld, e);
    }
  }

  private async onExit(ld: Live, instance: RuntimeInstance, code: number | null, signal: string | null) {
    if (ld.instance !== instance || ld.stopping || ld.relaunching) return;
    ld.monitor?.stop();
    if (ld.stableTimer) clearTimeout(ld.stableTimer);
    this.d.logs.system(ld.projectId, ld.id, `Process exited (code ${code ?? "none"}${signal ? `, ${signal}` : ""})`, code === 0 ? "info" : "error");
    this.d.bus.emit("runtime.crashed", { deploymentId: ld.id, projectId: ld.projectId, exitCode: code, signal });
    if (ld.state !== "LIVE") return; // startup failures are reported by launch()
    this.setHealth(ld, "CRASHED");
    ld.gateway?.setAvailable(false);

    const policy = ld.project!.restart;
    const shouldRestart = policy.policy === "always" || (policy.policy === "on-failure" && code !== 0);
    if (!shouldRestart) {
      if (code === 0) return void (await this.teardown(ld, "stopped"));
      return void (await this.fail(ld, new RynkError("PROCESS_EXITED", `${ld.project!.name} stopped unexpectedly (code ${code}).`, { suggestions: [`rynk logs ${ld.project!.name}`] })));
    }
    if (ld.restartAttempts >= policy.maxRetries) {
      const tail = this.d.logs.lastOutput(ld.projectId, ld.id);
      const why = explainOutput(tail);
      return void (await this.fail(ld, new RynkError("PROCESS_EXITED", `${ld.project!.name} crashed ${ld.restartAttempts + 1} times in a row; giving up.`, { causes: why.causes.length ? why.causes : tail.slice(-5), suggestions: [...why.suggestions, `rynk logs ${ld.project!.name}`] })));
    }
    ld.restartAttempts++;
    ld.restartCount++;
    const delay = backoffDelay(ld.restartAttempts, policy.initialBackoffMs, policy.maxBackoffMs);
    await this.transition(ld, "RESTARTING", `Restarting in ${(delay / 1000).toFixed(1)}s (attempt ${ld.restartAttempts}/${policy.maxRetries})`);
    this.d.bus.emit("runtime.restarted", { deploymentId: ld.id, projectId: ld.projectId, attempt: ld.restartAttempts });
    try {
      await sleep(delay, ld.abort.signal);
      if (ld.stopping) return;
      await this.launch(ld);
    } catch (e) {
      await this.fail(ld, e);
    }
  }

  private async teardown(ld: Live, desired: "running" | "stopped") {
    if (ld.stopping && isTerminal(ld.state)) return;
    const wasStopping = ld.stopping;
    ld.stopping = true;
    ld.abort.abort(new Error("stopped"));
    if (wasStopping) return;
    if (!isTerminal(ld.state)) await this.transition(ld, "STOPPING").catch(() => undefined);
    ld.monitor?.stop();
    if (ld.stableTimer) clearTimeout(ld.stableTimer);
    if (ld.exposure) await this.unshare(ld.projectId).catch(() => undefined);
    await ld.gateway?.stop().catch(() => undefined);
    if (ld.instance?.alive()) await ld.instance.stop().catch(() => undefined);
    if (ld.project) await this.d.runtimes.get(ld.project.runtime).cleanup?.(ld.project).catch(() => undefined);
    await this.releaseResources(ld);
    if (ld.state === "STOPPING") await this.transition(ld, "STOPPED");
    this.setHealth(ld, "STOPPED");
    await this.hostingUpdate(ld, { status: "stopped", endedAt: Date.now() });
    this.d.logs.unbind(ld.id);
    await this.persist(ld, { desired, stoppedAt: Date.now(), pid: null });
    this.d.bus.emit("runtime.stopped", { deploymentId: ld.id, projectId: ld.projectId, exitCode: null });
    if (this.live.get(ld.projectId) === ld) this.live.delete(ld.projectId);
  }

  private async releaseResources(ld: Live) {
    if (ld.route) {
      await this.d.proxy.remove(ld.route.id);
      await this.d.store.removeRoute(ld.route.id);
      this.d.bus.emit("route.removed", { routeId: ld.route.id });
      ld.route = undefined;
    }
    ld.gateway = undefined;
    const released = this.d.ports.release(ld.projectId);
    this.d.appPorts.release(ld.projectId);
    if (released) this.d.bus.emit("port.released", { projectId: ld.projectId, port: released });
  }

  private async fail(ld: Live, e: unknown) {
    if (ld.stopping) return;
    const err = RynkError.from(e);
    ld.error = err.toJSON();
    ld.monitor?.stop();
    if (ld.instance?.alive()) await ld.instance.stop(3000).catch(() => undefined);
    await ld.gateway?.stop().catch(() => undefined);
    if (ld.exposure) await this.unshare(ld.projectId).catch(() => undefined);
    await this.releaseResources(ld);
    this.d.logs.system(ld.projectId, ld.id, `✗ ${err.message}${err.causes.length ? "\n  " + err.causes.join("\n  ") : ""}`, "error");
    try {
      await this.transition(ld, "FAILED");
    } catch {
      ld.state = "FAILED";
    }
    this.setHealth(ld, "STOPPED");
    await this.hostingUpdate(ld, { status: "failed", endedAt: Date.now() });
    this.d.logs.unbind(ld.id);
    await this.persist(ld, { error: ld.error, desired: "stopped", pid: null, stoppedAt: Date.now() });
    this.d.bus.emit("deployment.failed", { deploymentId: ld.id, projectId: ld.projectId, error: { code: err.code, message: err.message, causes: err.causes, suggestions: err.suggestions } });
    this.d.logger.warn(`Deployment ${ld.id} failed: ${err.message}`);
    setTimeout(() => {
      if (this.live.get(ld.projectId) === ld) this.live.delete(ld.projectId);
    }, 5_000).unref();
  }

  // ── helpers ───────────────────────────────────────────────

  private async requireLive(idOrName: string, opts: { allowStarting?: boolean } = {}) {
    const ld = await this.find(idOrName);
    if (!ld || !ld.project || (!opts.allowStarting && ld.state !== "LIVE" && ld.state !== "RESTARTING")) {
      throw new RynkError("NOT_FOUND", "That project isn't live right now.", { suggestions: ["rynk start", "rynk status"] });
    }
    return ld;
  }

  private async transition(ld: Live, to: DeploymentState, message?: string) {
    if (ld.stopping && to !== "STOPPING" && to !== "STOPPED") throw new Error("stopped");
    assertTransition(ld.state, to);
    const from = ld.state;
    ld.state = to;
    await this.persist(ld, { state: to });
    const msg = message ?? STAGE_LABELS[to];
    if (msg && to !== "LIVE") this.d.logs.system(ld.projectId, ld.id, msg);
    this.d.bus.emit("deployment.state", { deploymentId: ld.id, projectId: ld.projectId, from, to, ...(msg ? { message: msg } : {}) });
  }

  private setHealth(ld: Live, to: HealthStatus) {
    if (ld.health === to) return;
    const from = ld.health;
    ld.health = to;
    void this.persist(ld, { health: to });
    const map: Partial<Record<HealthStatus, HostingStatus>> = { HEALTHY: "live", DEGRADED: "degraded", UNHEALTHY: "unhealthy", CRASHED: "restarting" };
    if (ld.hosting && ld.state === "LIVE" && map[to]) void this.hostingUpdate(ld, { status: map[to]! });
    this.d.bus.emit("health.changed", { deploymentId: ld.id, projectId: ld.projectId, from, to });
  }

  private async persist(ld: Live, patch: Parameters<Store["updateDeployment"]>[1]) {
    if (!ld.persisted) return;
    await this.d.store.updateDeployment(ld.id, patch).catch((e) => this.d.logger.error(`persist failed: ${(e as Error).message}`));
  }

  private say(ld: Live, m: string) {
    this.d.logs.system(ld.projectId, ld.id, m);
  }

  private warn(ld: Live, m: string) {
    if (!ld.warnings.includes(m)) ld.warnings.push(m);
    this.d.logs.system(ld.projectId, ld.id, `⚠ ${m}`, "warn");
  }

  private async find(idOrName: string): Promise<Live | undefined> {
    const direct = this.live.get(idOrName) ?? [...this.live.values()].find((l) => l.id === idOrName || l.project?.name === idOrName || l.root === idOrName || l.root === canonicalPath(idOrName));
    if (direct) return direct;
    const p = await this.d.store.getProject(idOrName);
    return p ? this.live.get(p.id) : undefined;
  }

  private cliOverrides(req: Partial<DeployRequest>) {
    return {
      ...(req.name ? { name: req.name } : {}),
      ...(req.runtime ? { runtime: req.runtime } : {}),
      ...(req.command ? { command: req.command } : {}),
      ...(req.port ? { port: req.port } : {}),
      ...(req.host ? { host: req.host } : {}),
      ...(req.exposure ? { exposure: req.exposure } : {}),
      ...(req.env ? { env: req.env } : {}),
      ...(req.maxUsers !== undefined ? { maxUsers: req.maxUsers } : {}),
      ...(req.protected !== undefined ? { accessMode: req.protected ? ("protected" as const) : ("open" as const) } : {}),
      ...(req.advertise !== undefined ? { advertise: req.advertise } : {}),
      ...(req.restart ? { restartPolicy: req.restart } : {}),
      ...(req.healthCheck !== undefined ? { healthCheck: req.healthCheck } : {}),
    };
  }

  private packageName(root: string): string | undefined {
    try {
      return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string }).name;
    } catch {
      return undefined;
    }
  }

  private async collectMetrics() {
    this.metricsTick++;
    for (const ld of this.live.values()) {
      if (ld.state !== "LIVE" || !ld.instance) continue;
      const s = await ld.instance.stats();
      const uptimeMs = Date.now() - (ld.liveAt ?? ld.instance.startedAt);
      ld.lastMetrics = s ? { ...s, uptimeMs } : { cpu: 0, memoryBytes: 0, uptimeMs };
      this.d.bus.emit("metrics.updated", { deploymentId: ld.id, projectId: ld.projectId, metrics: { ...ld.lastMetrics, restartCount: ld.restartCount, timestamp: Date.now() } });
      if (s && this.metricsTick % 6 === 0) await this.d.store.recordMetrics(ld.id, s.cpu, s.memoryBytes);
    }
  }

  /** LAN reachability of the share link, used by `rynk doctor` and `rynk network test`. */
  async checkLan(idOrName: string) {
    const ld = await this.find(idOrName);
    if (!ld?.sharePort) return null;
    const iface = this.selectedInterface(ld);
    if (!iface) return { ok: false, reason: "no network interface" };
    // Probe the gateway with its secret so the check itself never counts as a visitor.
    const r = await httpProbe(iface.address, ld.sharePort, "/", 2000, ld.gateway ? { "x-rynk-probe": ld.gateway.probeToken } : {});
    return { ok: r.ok, address: iface.address, port: ld.sharePort, error: r.error, status: r.status };
  }
}
