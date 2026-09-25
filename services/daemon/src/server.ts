import os from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { z } from "zod";
import {
  accessUpdateSchema,
  canonicalPath,
  disconnectRequestSchema,
  idParamSchema,
  inviteRequestSchema,
  logsQuerySchema,
  RynkError,
  shareRequestSchema,
  startRequestSchema,
  VERSION,
  packageManagerOf as corePackageManagerOf,
  runtimeCapabilities,
  type ErrorCode,
  type RynkNode,
} from "@rynk/core";
import type { NodeRegistry } from "@rynk/discovery";
import type { EventBus, EnvelopedEvent } from "@rynk/events";
import type { ExposureRegistry } from "@rynk/exposure";
import type { Logger } from "@rynk/logger";
import { primaryInterface, type NetworkWatcher } from "@rynk/network";
import type { ProxyProvider } from "@rynk/proxy";
import { isAllowedHost, isAllowedOrigin, isSensitiveKey, RateLimiter, safeEqual } from "@rynk/security";
import type { DeploymentEngine } from "./engine.js";
import type { DeviceAgent } from "./device.js";
import type { LogManager } from "./logs.js";
import type { PluginManager } from "./plugins.js";
import type { Store } from "./store.js";

export interface ServerDeps {
  token: string;
  engine: DeploymentEngine;
  store: Store;
  bus: EventBus;
  logs: LogManager;
  network: NetworkWatcher;
  proxy: ProxyProvider;
  exposures: ExposureRegistry;
  plugins: PluginManager;
  device: DeviceAgent;
  logger: Logger;
  startedAt: number;
  /** Discovery; absent when disabled (RYNK_DISCOVERY=off) and in some tests. */
  registry?: NodeRegistry;
  selfNode?: () => RynkNode;
  allowedHosts?: string[];
  onShutdown: () => void;
}

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  NOT_FOUND: 404,
  CONFIG_INVALID: 400,
  COMMAND_REJECTED: 400,
  DETECTION_FAILED: 422,
  DETECTION_AMBIGUOUS: 422,
  PORT_UNAVAILABLE: 409,
  RUNTIME_UNAVAILABLE: 424,
  DAEMON_UNAUTHORIZED: 401,
  EXPOSURE_FAILED: 502,
};

const deployBodySchema = startRequestSchema.extend({ foreground: z.boolean().optional(), wait: z.boolean().optional() });
const planQuerySchema = z.object({
  root: z.string().min(1).max(4096),
  runtime: startRequestSchema.shape.runtime,
  command: z.string().max(4096).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  host: z.string().max(255).optional(),
  name: z.string().max(64).optional(),
  exposure: z.enum(["local", "lan", "public"]).optional(),
  network: z.string().max(255).optional(),
  maxUsers: z.coerce.number().int().min(0).max(100_000).optional(),
});

const LEASE_GRACE_MS = 1_500;
const FOREGROUND_ATTACH_MS = 20_000;

const packageManagerOf = (p: Parameters<typeof corePackageManagerOf>[0]) => corePackageManagerOf(p) ?? null;

/** API responses never echo env values that look secret. */
function redactDefinition<T>(def: T): T {
  const d = def as { env?: Record<string, string> };
  if (!d || !d.env || typeof d.env !== "object") return def;
  return { ...d, env: Object.fromEntries(Object.entries(d.env).map(([k, v]) => [k, isSensitiveKey(k) ? "[REDACTED]" : v])) } as T;
}

/**
 * The daemon's local control API. Loopback-only, Bearer-token authenticated,
 * DNS-rebinding and CSRF protected, rate limited and Zod-validated. There is
 * no web dashboard: clients are the CLI, the native popup (via the CLI), the
 * Python client and the programmatic API.
 */
export async function createServer(d: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  const limiter = new RateLimiter(300, 100);
  const leases = new Map<string, Set<WebSocket>>();
  const leaseTimers = new Map<string, NodeJS.Timeout>();

  app.addHook("onRequest", async (req, reply) => {
    if (!isAllowedHost(req.headers.host, d.allowedHosts)) {
      return reply.code(421).send({ error: { code: "FORBIDDEN_HOST", message: "Host not allowed." } });
    }
    if (!isAllowedOrigin(req.headers.origin, req.headers.host, d.allowedHosts)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN_ORIGIN", message: "Origin not allowed." } });
    }
    if (!limiter.take(req.ip)) return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests." } });
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");
    if (req.url.split("?")[0] === "/api/health") return;
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ") || !safeEqual(auth.slice(7), d.token)) {
      return reply.code(401).send({ error: { code: "DAEMON_UNAUTHORIZED", message: "Missing or invalid credentials." } });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: { code: "CONFIG_INVALID", message: "Invalid request.", causes: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`), suggestions: [] } });
    }
    const fastifyStatus = (err as { statusCode?: number }).statusCode;
    if (!(err instanceof RynkError) && fastifyStatus && fastifyStatus < 500) {
      return reply.code(fastifyStatus).send({ error: { code: "BAD_REQUEST", message: (err as Error).message, causes: [], suggestions: [] } });
    }
    const re = RynkError.from(err);
    const status = HTTP_STATUS[re.code] ?? (re.code === "INTERNAL" ? 500 : 422);
    if (status >= 500) d.logger.error(`${req.method} ${req.url} → ${re.message}`);
    return reply.code(status).send({ error: re.toJSON() });
  });

  // ── helpers ────────────────────────────────────────────────
  const projectView = async (row: Awaited<ReturnType<Store["listProjects"]>>[number]) => {
    const live = d.engine.liveView(row.id);
    const snap = live ? d.engine.snapshot(live.id) : undefined;
    const latest = snap ? undefined : await d.store.latestDeployment(row.id);
    return {
      id: row.id, name: row.name, root: row.root, language: row.language, framework: row.framework, runtime: row.runtime,
      packageManager: packageManagerOf(row.definition as never),
      definition: redactDefinition(live?.project ?? row.definition),
      capabilities: runtimeCapabilities((live?.project ?? row.definition) as never),
      updatedAt: row.updatedAt,
      deployment: snap ?? (latest ? d.engine.view(latest) : null),
    };
  };

  const requireProject = async (id: string) => {
    const p = await d.store.getProject(id);
    if (!p) throw new RynkError("NOT_FOUND", `No project named "${id}".`, { suggestions: ["rynk projects"] });
    return p;
  };

  const attachLease = (deploymentId: string, socket: WebSocket) => {
    const set = leases.get(deploymentId) ?? new Set<WebSocket>();
    set.add(socket);
    leases.set(deploymentId, set);
    const t = leaseTimers.get(deploymentId);
    if (t) clearTimeout(t);
    leaseTimers.delete(deploymentId);
    socket.on("close", () => {
      set.delete(socket);
      if (set.size) return;
      leases.delete(deploymentId);
      const timer = setTimeout(() => {
        leaseTimers.delete(deploymentId);
        if (leases.has(deploymentId)) return;
        d.logger.info(`Foreground session for ${deploymentId} ended; stopping`);
        void d.engine.stopDeployment(deploymentId);
      }, LEASE_GRACE_MS);
      timer.unref();
      leaseTimers.set(deploymentId, timer);
    });
  };

  // ── system ─────────────────────────────────────────────────
  app.get("/api/health", async () => ({ ok: true, version: VERSION, pid: process.pid }));

  app.get("/api/info", async () => {
    const ifaces = d.network.current();
    const self = d.selfNode?.();
    return {
      version: VERSION, pid: process.pid, node: process.version, platform: `${process.platform}-${process.arch}`, hostname: os.hostname(),
      startedAt: d.startedAt, uptimeMs: Date.now() - d.startedAt,
      proxy: { provider: d.proxy.name, port: d.proxy.port },
      network: { primary: primaryInterface(ifaces) ?? null, interfaces: ifaces },
      activeDeployments: d.engine.activeCount(),
      plugins: d.plugins.list(),
      exposures: d.exposures.list().map((e) => ({ name: e.name, mode: e.mode })),
      device: d.device.current() ?? null,
      rynkNode: self ? { nodeId: self.nodeId, name: self.name, apiPort: self.apiPort } : null,
      memoryBytes: process.memoryUsage().rss,
    };
  });

  app.get("/api/network", async () => {
    const ifaces = d.network.current();
    const nodes = d.registry?.list({ includeSelf: false }) ?? [];
    return {
      primary: primaryInterface(ifaces) ?? null,
      interfaces: ifaces,
      discovery: { enabled: Boolean(d.registry), providers: d.registry?.providers() ?? [], nodes: nodes.length, online: nodes.filter((n) => n.status === "ONLINE").length },
      node: d.selfNode?.() ?? null,
      proxy: { port: d.proxy.port },
    };
  });

  app.get("/api/nodes", async () => d.registry?.list() ?? (d.selfNode ? [{ ...d.selfNode(), self: true }] : []));
  app.post("/api/nodes/refresh", async () => (d.registry ? d.registry.discover() : []));

  app.get("/api/apps", async () => {
    const nodes = d.registry?.list() ?? (d.selfNode ? [{ ...d.selfNode(), self: true }] : []);
    return nodes.flatMap((n) => n.apps.map((a) => ({ ...a, node: { nodeId: n.nodeId, name: n.name, address: n.address, status: n.status, self: Boolean(n.self) } })));
  });

  app.get("/api/hosting-sessions", async (req) => {
    const q = z.object({ projectId: z.string().max(128).optional(), limit: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query);
    let projectId = q.projectId;
    if (projectId) projectId = (await d.store.getProject(projectId))?.id ?? projectId;
    return d.store.listHostingSessions({ ...(projectId ? { projectId } : {}), limit: q.limit });
  });

  app.get("/api/nodes/known", async () => d.store.listKnownNodes());

  app.get("/api/ports", async () => ({ proxy: d.proxy.port, node: d.selfNode?.().apiPort ?? null, apps: d.engine.ports() }));

  // ── projects & deployments ─────────────────────────────────
  app.get("/api/projects", async () => Promise.all((await d.store.listProjects()).map(projectView)));

  app.get("/api/projects/:id", async (req) => projectView(await requireProject(idParamSchema.parse(req.params).id)));

  app.delete("/api/projects/:id", async (req) => {
    await d.engine.remove(idParamSchema.parse(req.params).id);
    return { ok: true };
  });

  app.post("/api/deployments", async (req) => {
    const body = deployBodySchema.parse(req.body ?? {});
    const { wait, ...request } = body;
    const result = await d.engine.deploy(request);
    if (request.foreground && !result.existing) {
      const timer = setTimeout(() => {
        if (!leases.has(result.deploymentId)) {
          d.logger.warn(`Foreground deployment ${result.deploymentId} was never attached; stopping`);
          void d.engine.stopDeployment(result.deploymentId);
        }
      }, FOREGROUND_ATTACH_MS);
      timer.unref();
    }
    if (!wait) return result;
    const outcome = await Promise.race([
      d.bus.once("deployment.completed", (p) => p.deploymentId === result.deploymentId).then((p) => ({ ok: true as const, urls: p.urls })),
      d.bus.once("deployment.failed", (p) => p.deploymentId === result.deploymentId).then((p) => ({ ok: false as const, error: p.error })),
      d.bus.once("runtime.stopped", (p) => p.deploymentId === result.deploymentId).then(() => ({ ok: false as const, error: { code: "STOPPED", message: "Deployment was stopped.", causes: [], suggestions: [] } })),
    ]);
    return { ...result, ...outcome, deployment: d.engine.snapshot(result.deploymentId) ?? null };
  });

  app.get("/api/deployments", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const rows = await d.store.listDeployments(limit);
    const persisted = new Set(rows.map((r) => r.id));
    const early = d.engine.liveIds().filter((l) => !persisted.has(l.id)).map((l) => d.engine.snapshot(l.id)).filter(Boolean);
    return [...early, ...rows.map((r) => d.engine.view(r))];
  });

  app.get("/api/deployments/:id", async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const snap = d.engine.snapshot(id);
    if (snap) return snap;
    const row = await d.store.getDeployment(id);
    if (!row) throw new RynkError("NOT_FOUND", `No deployment ${id}.`);
    return d.engine.view(row);
  });

  app.post("/api/projects/:id/stop", async (req) => {
    const row = await d.engine.stop(idParamSchema.parse(req.params).id);
    return row ? d.engine.view(row) : { ok: true };
  });

  app.post("/api/projects/:id/restart", async (req) => d.engine.restart(idParamSchema.parse(req.params).id));

  app.post("/api/projects/:id/redeploy", async (req) => {
    const p = await requireProject(idParamSchema.parse(req.params).id);
    await d.engine.stop(p.id, { keepDesired: true }).catch(() => undefined);
    const request = (await d.store.getSetting<Record<string, unknown>>(`request:${p.id}`)) ?? {};
    return d.engine.deploy({ ...request, root: p.root, install: true, foreground: false });
  });

  app.get("/api/projects/:id/logs", async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const q = logsQuerySchema.parse(req.query);
    const p = await requireProject(id).catch(() => undefined);
    const projectId = p?.id ?? d.engine.liveIds().find((l) => l.projectId === id || l.id === id)?.projectId;
    if (!projectId) throw new RynkError("NOT_FOUND", `No project named "${id}".`, { suggestions: ["rynk projects"] });
    return d.logs.recent(projectId, q.limit, q.since);
  });

  app.get("/api/projects/:id/metrics", async (req) => {
    const p = await requireProject(idParamSchema.parse(req.params).id);
    const latest = await d.store.latestDeployment(p.id);
    return { current: d.engine.liveView(p.id)?.lastMetrics ?? null, history: latest ? await d.store.metricsFor(latest.id) : [] };
  });

  app.get("/api/projects/:id/lan-check", async (req) => (await d.engine.checkLan(idParamSchema.parse(req.params).id)) ?? { ok: false, reason: "not live" });

  // ── sharing & access control ───────────────────────────────
  app.post("/api/projects/:id/share", async (req) => {
    const opts = shareRequestSchema.parse(req.body ?? {});
    return d.engine.share(idParamSchema.parse(req.params).id, { public: opts.public, ...(opts.provider ? { provider: opts.provider } : {}) });
  });

  app.delete("/api/projects/:id/share", async (req) => {
    await d.engine.unshare(idParamSchema.parse(req.params).id);
    return { ok: true };
  });

  app.get("/api/projects/:id/clients", async (req) => d.engine.clients(idParamSchema.parse(req.params).id));

  app.post("/api/projects/:id/clients/:sid/disconnect", async (req) => {
    const { id, sid } = z.object({ id: z.string().min(1).max(128), sid: z.string().min(1).max(64) }).parse(req.params);
    const { block } = disconnectRequestSchema.parse(req.body ?? {});
    return d.engine.disconnect(id, sid, { block });
  });

  app.post("/api/projects/:id/unblock", async (req) => {
    const { address } = z.object({ address: z.string().min(1).max(64) }).parse(req.body ?? {});
    return d.engine.unblock(idParamSchema.parse(req.params).id, address);
  });

  app.patch("/api/projects/:id/access", async (req) => {
    const patch = accessUpdateSchema.parse(req.body ?? {});
    return d.engine.updateAccess(idParamSchema.parse(req.params).id, patch);
  });

  app.post("/api/projects/:id/invites", async (req) => {
    const { ttlMs, maxUses } = inviteRequestSchema.parse(req.body ?? {});
    return d.engine.createInvite(idParamSchema.parse(req.params).id, ttlMs, maxUses);
  });

  app.delete("/api/projects/:id/invites/:iid", async (req) => {
    const { id, iid } = z.object({ id: z.string().min(1).max(128), iid: z.string().min(1).max(64) }).parse(req.params);
    return d.engine.revokeInvite(id, iid);
  });

  // ── planning ───────────────────────────────────────────────
  const planHandler = async (q: z.infer<typeof planQuerySchema>) => {
    const { root, ...rest } = q;
    const absRoot = canonicalPath(root);
    const request = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    try {
      const plan = await d.engine.plan(absRoot, { root: absRoot, ...request } as never);
      const ifaces = d.network.current();
      const chosen = (q.network && ifaces.find((i) => i.name.toLowerCase() === q.network!.toLowerCase() || i.address === q.network)) || primaryInterface(ifaces) || null;
      return {
        best: plan.report.best, candidates: plan.report.candidates, ambiguous: plan.report.ambiguous,
        project: redactDefinition(plan.project), packageManager: plan.report.best?.packageManager ?? packageManagerOf(plan.project),
        capabilities: runtimeCapabilities(plan.project),
        sharePort: plan.sharePort, running: plan.running,
        interfaces: ifaces, network: chosen,
        shareUrl: plan.sharePort ? `http://${plan.project.exposure === "local" || !chosen ? "localhost" : chosen.address}:${plan.sharePort}` : null,
      };
    } catch (e) {
      const re = RynkError.from(e);
      if (re.code === "NOT_FOUND") throw re;
      return { best: null, candidates: [], project: null, error: re.toJSON(), interfaces: d.network.current(), network: primaryInterface(d.network.current()) ?? null };
    }
  };
  app.get("/api/plan", async (req) => planHandler(planQuerySchema.parse(req.query)));
  app.get("/api/detect", async (req) => planHandler(planQuerySchema.parse(req.query)));

  app.get("/api/routes", async () => d.proxy.list());

  app.get("/api/devices", async () => {
    const { DeviceAgent } = await import("./device.js");
    return (await d.store.listDevices()).map((dev) => ({ ...dev, status: DeviceAgent.classify(dev.lastHeartbeat) }));
  });

  app.get("/api/metrics", async () => {
    const projects = await d.store.listProjects();
    return {
      daemon: { memoryBytes: process.memoryUsage().rss, uptimeMs: Date.now() - d.startedAt },
      activeDeployments: d.engine.activeCount(),
      projects: projects.map((p) => ({ id: p.id, name: p.name, metrics: d.engine.liveView(p.id)?.lastMetrics ?? null })),
    };
  });

  app.post("/api/shutdown", async (_req, reply) => {
    await reply.send({ ok: true });
    setImmediate(() => d.onShutdown());
    return reply;
  });

  // ── realtime ───────────────────────────────────────────────
  app.get("/api/events", { websocket: true }, (socket, req) => {
    const q = z.object({ projectId: z.string().max(128).optional(), lease: z.string().max(128).optional() }).safeParse(req.query);
    if (!q.success) return socket.close(1008, "bad query");
    const { projectId, lease } = q.data;
    if (lease) attachLease(lease, socket);
    const send = (e: EnvelopedEvent) => {
      const p = e.payload as { projectId?: string; entry?: { projectId?: string }; route?: { projectId?: string } };
      const pid = p.projectId ?? p.entry?.projectId ?? p.route?.projectId;
      if (projectId && pid && pid !== projectId) return;
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
    };
    const off = d.bus.onAny(send);
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 20_000);
    ping.unref();
    socket.on("close", () => {
      off();
      clearInterval(ping);
    });
    socket.on("message", (raw: Buffer) => {
      if (String(raw).includes('"ping"')) socket.send(JSON.stringify({ type: "pong", timestamp: Date.now(), payload: {} }));
    });
    socket.send(JSON.stringify({ type: "hello", timestamp: Date.now(), payload: { version: VERSION } }));
  });

  return app;
}
