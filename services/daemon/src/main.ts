#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, paths, VERSION } from "@rynk/core";
import { openDatabase } from "@rynk/database";
import { DetectorRegistry } from "@rynk/detector";
import { EventBus } from "@rynk/events";
import { ExposureRegistry } from "@rynk/exposure";
import { consoleSink, fileSink, Logger } from "@rynk/logger";
import { NetworkWatcher } from "@rynk/network";
import { canBind, MemoryPortStore, PortAllocator } from "@rynk/ports";
import { loadIdentity, MdnsDiscovery, NodeInfoServer, NodeRegistry, nodeName, UdpDiscovery, DEFAULT_NODE_PORT, DEFAULT_UDP_PORT, type DiscoveryProvider } from "@rynk/discovery";
import type { RynkNode } from "@rynk/core";
import os from "node:os";
import { BuiltinProxy, CaddyProxy, type ProxyProvider } from "@rynk/proxy";
import { RuntimeRegistry } from "@rynk/runtime";
import { readDaemonState, RynkClient, type DaemonState } from "@rynk/sdk";
import { generateToken } from "@rynk/security";
import { DeviceAgent } from "./device.js";
import { DeploymentEngine } from "./engine.js";
import { LogManager } from "./logs.js";
import { PluginManager } from "./plugins.js";
import { createServer } from "./server.js";
import { SecretBox } from "./secrets.js";
import { Store } from "./store.js";

const PERSISTED_EVENTS = new Set([
  "deployment.created", "deployment.completed", "deployment.failed",
  "runtime.crashed", "runtime.restarted", "network.changed",
  "exposure.created", "exposure.closed",
]);

function envPort(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : fallback;
}

async function pickProxyPort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 20; p++) {
    if (await canBind(p, "0.0.0.0")) return p;
  }
  throw new Error(`No free port for the Rynk proxy near ${preferred}`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function startDaemon(opts: { foregroundLogs?: boolean } = {}) {
  const home = paths.home();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  // Single instance: if a healthy daemon already owns daemon.json, bail out.
  const existing = readDaemonState();
  if (existing && existing.pid !== process.pid && isRunning(existing.pid)) {
    const alive = await new RynkClient(existing).health().then(() => true, () => false);
    if (alive) {
      process.stderr.write(`Rynk daemon already running (pid ${existing.pid}).\n`);
      return null;
    }
  }

  const logger = new Logger({
    source: "daemon",
    sinks: [fileSink(paths.daemonLog()), ...(opts.foregroundLogs || process.env.RYNK_DAEMON_STDERR ? [consoleSink()] : [])],
  });
  const startedAt = Date.now();
  const bus = new EventBus();
  const db = openDatabase(paths.database());
  const identity = loadIdentity(home);
  const store = new Store(db, new SecretBox(home));
  await store.endOrphanedHostingSessions(); // sessions a crashed daemon left open
  await store.prune(); // clean stale logs, dead nodes, and old sessions on startup
  const logs = new LogManager(store, bus, identity.nodeId);

  const detectors = new DetectorRegistry();
  const runtimes = new RuntimeRegistry();
  const exposures = new ExposureRegistry();
  const plugins = new PluginManager({ detectors, runtimes, exposures }, logger.child("plugins"));
  await plugins.loadGlobal();

  const ports = new PortAllocator(store.portStore(), [
    envPort("RYNK_PORT_MIN", DEFAULTS.portRangeStart),
    envPort("RYNK_PORT_MAX", DEFAULTS.portRangeEnd),
  ]);
  // Apps listen on loopback ports from a separate range; only the gateway's share port faces the network.
  const appPorts = new PortAllocator(new MemoryPortStore(), [envPort("RYNK_APP_PORT_MIN", 41000), envPort("RYNK_APP_PORT_MAX", 41999)]);
  const network = new NetworkWatcher(bus);
  await network.init(); // learn the default route before ranking interfaces
  const proxyPort = await pickProxyPort(envPort("RYNK_PROXY_PORT", DEFAULTS.proxyPort));
  const proxy: ProxyProvider = process.env.RYNK_PROXY === "caddy"
    ? new CaddyProxy(proxyPort, process.env.RYNK_CADDY_ADMIN)
    : new BuiltinProxy(proxyPort, process.env.RYNK_PROXY_HOST ?? "127.0.0.1");
  await proxy.start();
  // Routes are re-created by restored deployments; stale DB rows are cleared.
  db.raw.exec("DELETE FROM routes");

  const device = new DeviceAgent(store, network);
  await device.register().catch((e) => logger.warn(`Device registration failed: ${(e as Error).message}`));
  device.start();

  const engine = new DeploymentEngine({ store, bus, logs, detectors, runtimes, ports, appPorts, proxy, network, exposures, plugins, logger: logger.child("engine"), nodeId: identity.nodeId });

  // ── LAN discovery: identity, read-only node info, UDP + mDNS announcements ──
  let rev = 1;
  let nodeServer: NodeInfoServer | undefined;
  const selfNode = (): RynkNode => {
    const ifaces = network.current();
    const primary = ifaces[0];
    return {
      nodeId: identity.nodeId, name: nodeName(), hostname: os.hostname(),
      address: primary?.address ?? "127.0.0.1", addresses: ifaces.map((i) => i.address),
      apiPort: nodeServer?.port ?? 0, platform: process.platform, arch: process.arch, version: VERSION, rev,
      capabilities: ["host", "discover"], apps: engine.publicApps(), status: "ONLINE", lastSeen: Date.now(),
    };
  };
  const discoveryMode = (process.env.RYNK_DISCOVERY ?? "all").toLowerCase();
  let registry: NodeRegistry | undefined;
  if (discoveryMode !== "off") {
    nodeServer = new NodeInfoServer(selfNode, { port: envPort("RYNK_NODE_PORT", DEFAULT_NODE_PORT), identity });
    const providers: DiscoveryProvider[] = [];
    const discIfaces = process.env.RYNK_DISCOVERY_INTERFACES
      ? () => process.env.RYNK_DISCOVERY_INTERFACES!.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    if (discoveryMode === "all" || discoveryMode === "udp") {
      providers.push(new UdpDiscovery({
        port: envPort("RYNK_DISCOVERY_PORT", DEFAULT_UDP_PORT),
        ...(discIfaces ? { interfaces: discIfaces } : {}),
      }));
    }
    if (discoveryMode === "all" || discoveryMode === "mdns") providers.push(new MdnsDiscovery());
    registry = new NodeRegistry({
      providers,
      self: selfNode,
      onEvent: (kind, node) => {
        bus.emit(kind === "discovered" ? "node.discovered" : kind === "lost" ? "node.lost" : "node.updated", { node });
        if (kind !== "lost") void store.upsertNode(node).catch(() => undefined);
      },
      onWarn: (m) => logger.warn(m),
    });
  }
  // Re-announce (cheaply: only rev changes on the wire) whenever what we advertise changes.
  let announceTimer: NodeJS.Timeout | undefined;
  const bump = () => {
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      rev++;
      void registry?.announce();
    }, 300);
    announceTimer.unref();
  };
  for (const ev of ["deployment.completed", "deployment.failed", "runtime.stopped", "urls.updated", "access.updated", "network.changed"] as const) bus.on(ev, bump);

  bus.onAny((e) => {
    if (PERSISTED_EVENTS.has(e.type)) void store.recordEvent(e.type, e.payload).catch(() => undefined);
  });
  bus.on("network.changed", (e) => logger.info(`Network changed: primary ${e.payload.primary?.address ?? "none"}`));

  const token = process.env.RYNK_INTERNAL_DAEMON_TOKEN || generateToken(32);
  const host = process.env.RYNK_DAEMON_HOST ?? DEFAULTS.daemonHost;
  const port = envPort("RYNK_DAEMON_PORT", envPort("RYNK_PORT", DEFAULTS.daemonPort));

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Shutting down (${reason})`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await engine.shutdown().catch(() => undefined);
    await app.close().catch(() => undefined);
    await proxy.stop().catch(() => undefined);
    network.stop();
    device.stop();
    clearInterval(pruneTimer);
    await registry?.stop().catch(() => undefined);
    await nodeServer?.stop().catch(() => undefined);
    await store.close().catch(() => undefined);
    const state = readDaemonState();
    if (state?.pid === process.pid) fs.rmSync(paths.daemonState(), { force: true });
    clearTimeout(force);
    process.exit(0);
  };

  const allowedHosts = (process.env.RYNK_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const app = await createServer({
    token, engine, store, bus, logs, network, proxy, exposures, plugins, device,
    logger: logger.child("api"), startedAt, allowedHosts, selfNode, ...(registry ? { registry } : {}),
    onShutdown: () => void shutdown("api"),
  });

  try {
    await app.listen({ host, port });
  } catch (e) {
    logger.error(`Cannot listen on ${host}:${port}: ${(e as Error).message}`);
    process.stderr.write(`Rynk daemon could not listen on ${host}:${port} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).\n`);
    await proxy.stop().catch(() => undefined);
    await store.close().catch(() => undefined);
    process.exit(1);
  }

  const state: DaemonState = { pid: process.pid, host: host === "0.0.0.0" ? "127.0.0.1" : host, port, token, version: VERSION, startedAt, proxyPort, nodeId: identity.nodeId };
  const tmp = paths.daemonState() + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, paths.daemonState()); // atomic replace

  network.start();
  engine.startMetrics();
  if (nodeServer && registry) {
    try {
      await nodeServer.start();
      await registry.start();
      logger.info(`Discovery on (${registry.providers().filter((p) => p.ok).map((p) => p.name).join(", ") || "no providers"}), node ${identity.nodeId}, info port ${nodeServer.port}`);
    } catch (e) {
      logger.warn(`Discovery unavailable: ${(e as Error).message}`);
    }
  }
  const pruneTimer = setInterval(() => {
    try {
      store.prune();
    } catch (e) {
      logger.warn(`Prune failed: ${(e as Error).message}`);
    }
  }, 10 * 60_000);
  pruneTimer.unref();

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("uncaughtException", (e) => logger.error(`Uncaught: ${e.stack ?? e.message}`));
  process.on("unhandledRejection", (e) => logger.error(`Unhandled rejection: ${(e as Error)?.stack ?? String(e)}`));

  logger.info(`Rynk daemon ${VERSION} listening on http://${host}:${port} (proxy :${proxyPort}, data ${path.dirname(paths.database())})`);
  await engine.restore().catch((e) => logger.error(`Restore failed: ${(e as Error).message}`));
  return { app, engine, state, shutdown };
}

const invokedDirectly = (() => {
  try {
    const arg = process.argv[1];
    if (!arg) return false;
    const a = path.resolve(fs.realpathSync(arg));
    const b = path.resolve(fs.realpathSync(fileURLToPath(import.meta.url)));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void startDaemon({ foregroundLogs: process.argv.includes("--foreground") }).then((r) => {
    if (!r) process.exit(0);
  });
}
