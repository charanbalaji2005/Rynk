import path from "node:path";
import ora, { type Ora } from "ora";
import qrcode from "qrcode-terminal";
import { canonicalPath, RynkError, STAGE_LABELS, type ClientSession, type DeploymentURLs, type LogEntry, type StartRequest } from "@rynk/core";
import { openPopup, qrMatrix, runtimeFromChoice, RUNTIME_CHOICES, type PopupInit, type PopupSession, type PopupSettings } from "@rynk/popup";
import type { DeploymentView, EventMessage, Plan, RynkClient } from "@rynk/sdk";
import { ensureDaemon } from "./daemon-control.js";
import { box, c, healthText, isTTY, json, printError, runtimeLabel, shareUrl, sym, urlLines, usersText } from "./ui.js";

export interface UpOptions {
  cmd?: string;
  port?: string | number;
  host?: string;
  runtime?: string;
  name?: string;
  local?: boolean;
  lan?: boolean;
  public?: boolean;
  network?: string;
  maxUsers?: string | number;
  protected?: boolean;
  advertise?: boolean;
  restart?: boolean;
  healthCheck?: boolean;
  install?: boolean;
  env?: string[];
  json?: boolean;
  verbose?: boolean;
  qr?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  popup?: boolean;
}

type Snapshot = DeploymentView;
type Outcome = { ok: true; snap: Snapshot } | { ok: false; error: RynkError };

const STAGE_TEXT = new Set(Object.values(STAGE_LABELS));
const EXPLICIT_FLAGS: Array<keyof UpOptions> = ["cmd", "port", "host", "runtime", "name", "local", "lan", "public", "network", "maxUsers", "protected"];

export function buildRequest(root: string, o: UpOptions, foreground: boolean): StartRequest & { foreground: boolean } {
  const port = o.port !== undefined ? Number(o.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new RynkError("CONFIG_INVALID", `"${o.port}" is not a valid port.`, { suggestions: ["rynk --port 8080"] });
  }
  const maxUsers = o.maxUsers !== undefined ? Number(o.maxUsers) : undefined;
  if (maxUsers !== undefined && (!Number.isInteger(maxUsers) || maxUsers < 0)) {
    throw new RynkError("CONFIG_INVALID", `"${o.maxUsers}" is not a valid user limit.`, { suggestions: ["rynk --max-users 10   (0 = unlimited)"] });
  }
  if (o.local && (o.lan || o.public)) throw new RynkError("CONFIG_INVALID", "--local can't be combined with --lan or --public.");
  const env: Record<string, string> = {};
  for (const kv of o.env ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw new RynkError("CONFIG_INVALID", `--env expects KEY=value, got "${kv}".`);
    env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return {
    root: canonicalPath(root),
    foreground,
    ...(o.cmd ? { command: o.cmd } : {}),
    ...(port ? { port } : {}),
    ...(o.host && o.host.toLowerCase() !== "auto" ? { host: o.host } : {}),
    ...(o.runtime ? { runtime: o.runtime as StartRequest["runtime"] } : {}),
    ...(o.name ? { name: o.name } : {}),
    ...(o.local ? { exposure: "local" as const } : o.lan || o.public ? { exposure: "lan" as const } : {}),
    ...(o.public ? { public: true } : {}),
    ...(o.network ? { network: o.network } : {}),
    ...(maxUsers !== undefined ? { maxUsers } : {}),
    ...(o.protected ? { protected: true } : {}),
    ...(o.advertise === false ? { advertise: false } : {}),
    ...(o.restart === false ? { restart: "never" as const } : {}),
    ...(o.healthCheck === false ? { healthCheck: false } : {}),
    ...(o.install === false ? { install: false } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  };
}

/** Show the popup only for a plain interactive `rynk`: flags, --yes, --json, CI and pipes all skip it. */
export function wantsPopup(o: UpOptions, env: NodeJS.ProcessEnv = process.env): boolean {
  if (o.popup === false || o.json || o.yes || o.nonInteractive || env.CI) return false;
  if (o.popup === true) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  return !EXPLICIT_FLAGS.some((k) => o[k] !== undefined && o[k] !== false);
}

export function printQr(url: string): Promise<void> {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (code) => {
      process.stdout.write(code.split("\n").map((l) => "  " + l).join("\n") + "\n");
      resolve();
    });
  });
}

export function liveBox(snap: Snapshot, extra: string[] = []): string {
  const name = snap.name ?? snap.projectId;
  const lines = [
    `${c.ok.bold("● LIVE")}  ${c.bold(name)}`,
    "",
    ...urlLines(snap.urls),
    "",
    ...(snap.hostingSession?.hostAddress && snap.urls?.network ? [`${c.label("Host IP:")} ${snap.hostingSession.hostAddress}`] : []),
    `${c.label("Status: ")} ${healthText(snap.health)}${snap.port ? c.dim(`   port ${snap.port}`) : ""}${snap.pid ? c.dim(`   pid ${snap.pid}`) : ""}`,
    `${c.label("Users:  ")} ${usersText(snap.access)}`,
  ];
  for (const w of snap.warnings ?? []) lines.push(`${sym.warn} ${c.warn(w)}`);
  return box([...lines, ...extra], { title: c.brand("RYNK HOSTING") });
}

function popupInit(plan: Plan, root: string, req: StartRequest): PopupInit {
  const p = plan.project;
  const ifaces = plan.interfaces.filter((i) => i.kind !== "virtual" && i.kind !== "loopback");
  const kindLabel: Record<string, string> = { wifi: "Wi-Fi", ethernet: "Ethernet", vpn: "VPN" };
  const ports = [...new Set([3000, 5173, 8000, 8080, ...(plan.sharePort ? [plan.sharePort] : [])])].sort((a, b) => a - b);
  const command = p?.start.display && p.start.display !== "(container)" ? p.start.display : "";
  return {
    type: "init",
    project: {
      name: p?.name ?? path.basename(root),
      root,
      ...(p?.framework ? { framework: p.framework } : {}),
      runtimeLabel: runtimeLabel(p?.language, p?.runtime),
      packageManager: plan.packageManager ?? null,
      command,
    },
    options: { runtimes: [...RUNTIME_CHOICES], ports },
    network: { interfaces: ifaces.map((i) => ({ name: i.name, address: i.address, kind: i.kind, label: kindLabel[i.kind] ?? i.name })), selected: plan.network?.address ?? ifaces[0]?.address ?? "" },
    defaults: {
      name: p?.name ?? path.basename(root),
      command,
      runtime: "Auto",
      port: req.port ?? "Auto",
      host: req.host ?? "Auto",
      exposure: req.public ? "public" : (p?.exposure ?? "lan"),
      maxUsers: p?.access.maxUsers ?? 0,
      protected: p?.access.mode === "protected",
      autoRestart: (p?.restart.policy ?? "on-failure") !== "never",
      healthCheck: !["process", "none"].includes(p?.health.type ?? "http"),
      advertise: p?.access.advertise ?? true,
    },
    sharePort: plan.sharePort ?? null,
  };
}

/** Apply what the user chose in the popup on top of the original request. */
export function applySettings(req: StartRequest & { foreground: boolean }, s: PopupSettings, init: PopupInit): StartRequest & { foreground: boolean } {
  const out = { ...req };
  const runtime = runtimeFromChoice(s.runtime);
  if (s.name && s.name !== init.project.name) out.name = s.name;
  if (s.command && (s.command !== init.project.command || runtime === "custom")) out.command = s.command;
  if (runtime !== "auto") out.runtime = runtime;
  if (s.port) out.port = s.port;
  if (s.host && s.host !== "Auto") out.host = s.host;
  if (s.network) out.network = s.network;
  out.exposure = s.exposure === "public" ? "lan" : s.exposure;
  if (s.exposure === "public") out.public = true;
  out.maxUsers = s.maxUsers;
  out.protected = s.protected;
  out.advertise = s.advertise;
  if (!s.autoRestart) out.restart = "never";
  if (!s.healthCheck) out.healthCheck = false;
  return out;
}

/**
 * Host a project from the terminal: optional "Host this project" popup,
 * pipeline progress, the LIVE box with the share link, live client events —
 * and in foreground mode a lease so Ctrl+C (or closing the terminal) stops it.
 */
export async function up(root: string, o: UpOptions, mode: "foreground" | "detached"): Promise<number> {
  const quiet = Boolean(o.json);
  const spinner: Ora = ora({ isEnabled: isTTY && !quiet, isSilent: quiet, discardStdin: false, stream: process.stdout });
  const say = (line: string) => {
    if (quiet) return;
    const spinning = spinner.isSpinning;
    const text = spinner.text;
    if (spinning) spinner.stop();
    process.stdout.write(line + "\n");
    if (spinning) spinner.start(text);
  };

  if (!quiet) process.stdout.write(`\n${c.brand("RYNK")} ${c.dim("local network hosting")}\n\n`);
  spinner.start("Connecting to the Rynk daemon");
  const client = await ensureDaemon({ quiet });
  let req = buildRequest(root, o, mode === "foreground");

  // ── the "Host this project" popup ──
  let popup: PopupSession | null = null;
  if (wantsPopup(o)) {
    spinner.text = "Detecting project";
    const plan = await client.plan(req.root, { runtime: req.runtime, command: req.command, port: req.port, name: req.name, network: req.network });
    spinner.stop();
    const init = popupInit(plan, req.root, req);
    popup = await openPopup(init, { onDebug: (m) => o.verbose && say(c.dim(m)) });
    if (popup) {
      if (popup.isWindow) say(`${sym.info} Confirm the settings in the Rynk window ${c.dim("(or press Ctrl+C here)")}`);
      const choice = await new Promise<PopupSettings | null>((resolve) => {
        popup!.on((m) => {
          if (m.type === "start") resolve(m.settings);
          if (m.type === "cancel" || (m.type === "closed" && !popup!.isOpen)) resolve(null);
        });
        process.once("SIGINT", () => resolve(null));
      });
      if (!choice) {
        popup.close();
        say(c.dim("Cancelled. Nothing was started."));
        return 0;
      }
      req = applySettings(req, choice, init);
      if (req.public && !o.public) say(`${sym.warn} ${c.warn("Public tunnel selected: anyone with the link will be able to open it.")}`);
    }
  }

  spinner.start("Starting");
  const res = await client.deploy(req);
  spinner.stop();
  if (res.existing) {
    popup?.close();
    return attachExisting(client, res.projectId, o, mode);
  }

  let stageLabel = "";
  let live = false;
  let logsToPopup = false;
  let resolveOutcome!: (o: Outcome) => void;
  const outcome = new Promise<Outcome>((r) => (resolveOutcome = r));
  const stopped = deferred();

  const finishStage = () => {
    if (stageLabel && spinner.isSpinning) spinner.stopAndPersist({ symbol: sym.ok, text: stageLabel });
    else if (stageLabel && !quiet && !isTTY) process.stdout.write(`${sym.ok} ${stageLabel}\n`);
  };

  const onEvent = (e: EventMessage) => {
    const p = e.payload;
    if (p.deploymentId && p.deploymentId !== res.deploymentId) return;
    switch (e.type) {
      case "deployment.state": {
        const to = String(p.to);
        if (to === "LIVE" || to === "FAILED" || to === "STOPPING" || to === "STOPPED") {
          if (!live && to !== "FAILED") finishStage();
          if (to === "FAILED" && spinner.isSpinning) spinner.stopAndPersist({ symbol: sym.fail, text: stageLabel });
          stageLabel = "";
          break;
        }
        if (to === "RESTARTING") {
          say(`${sym.warn} ${c.warn(String(p.message ?? "Restarting"))}`);
          popup?.send({ type: "status", health: "RESTARTING", pid: null, users: { active: 0, limit: 0 }, clients: [] });
          break;
        }
        if (live && to !== "STARTING") break;
        if (!live) finishStage();
        stageLabel = String(p.message ?? to);
        if (!live) {
          spinner.start(stageLabel);
          popup?.send({ type: "progress", text: stageLabel });
        }
        break;
      }
      case "log.received": {
        const entry = p.entry as LogEntry;
        if (!entry || entry.deploymentId !== res.deploymentId) break;
        if (logsToPopup) popup?.send({ type: "log", line: entry.message });
        if (entry.stream === "system") {
          if (STAGE_TEXT.has(entry.message) || entry.message.startsWith("✗")) break;
          if (entry.message.startsWith("$ ")) {
            if (!live) spinner.text = `${stageLabel} ${c.dim(entry.message)}`;
            break;
          }
          if (entry.message.startsWith("⚠")) say(`${sym.warn} ${c.warn(entry.message.slice(1).trim())}`);
          else if (entry.message.startsWith("Network changed")) say(`${sym.info} ${entry.message}`);
          else if (!live || o.verbose) say(c.dim("  " + entry.message));
          break;
        }
        if (live) {
          if (mode === "foreground" && !quiet && !o.nonInteractive) process.stdout.write(`${c.dim("│")} ${entry.stream === "stderr" ? c.warn(entry.message) : entry.message}\n`);
        } else if (o.verbose) say(c.dim(`  │ ${entry.message}`));
        else if (spinner.isSpinning) {
          const width = Math.max(10, (process.stdout.columns || 80) - stageLabel.length - 8);
          spinner.text = `${stageLabel} ${c.dim(entry.message.trim().slice(0, width))}`;
        }
        break;
      }
      case "deployment.completed":
        if (live) {
          say(`${sym.ok} Back online`);
          void pushStatus();
          break;
        }
        live = true;
        void client.request<Snapshot>("GET", `/api/deployments/${res.deploymentId}`).then((snap) => resolveOutcome({ ok: true, snap }), (err) => resolveOutcome({ ok: false, error: RynkError.from(err) }));
        break;
      case "deployment.failed": {
        const err = p.error as { code: string; message: string; causes: string[]; suggestions: string[] };
        const re = new RynkError(err.code as never, err.message, { causes: err.causes, suggestions: err.suggestions });
        if (live) {
          printError(re);
          popup?.send({ type: "failed", message: err.message, causes: err.causes, suggestions: err.suggestions });
          stopped.resolve();
        } else resolveOutcome({ ok: false, error: re });
        break;
      }
      case "urls.updated":
        if (live) {
          say(`${sym.info} Share link updated:`);
          for (const l of urlLines(p.urls as DeploymentURLs)) say("  " + l);
          void pushStatus();
        }
        break;
      case "access.session": {
        if (!live || quiet) break;
        const s = p.session as ClientSession;
        const count = `${String(p.active)}/${Number(p.limit) || "∞"}`;
        if (p.kind === "opened") say(`${c.ok("→")} ${s.clientAddress} connected ${c.dim(`(${count} active)`)}`);
        if (p.kind === "closed") say(`${c.dim("←")} ${s.clientAddress} ${c.dim(`left (${count} active)`)}`);
        void pushStatus();
        break;
      }
      case "access.denied":
        if (live && !quiet) say(`${sym.warn} ${c.warn(`Refused ${String(p.clientAddress)}: ${p.reason === "limit" ? "user limit reached" : p.reason === "protected" ? "no invite" : String(p.reason)}`)}`);
        break;
      case "runtime.crashed":
        if (live) say(`${sym.warn} ${c.warn(`The app exited (code ${String(p.exitCode ?? "none")}).`)}`);
        break;
      case "runtime.stopped":
        if (live) stopped.resolve();
        break;
    }
  };

  let closedByUs = false;
  const sub = client.events({
    projectId: res.projectId,
    ...(mode === "foreground" ? { lease: res.deploymentId } : {}),
    onEvent,
    onClose: () => {
      if (!closedByUs) {
        resolveOutcome({ ok: false, error: new RynkError("DAEMON_UNREACHABLE", "Lost connection to the Rynk daemon.", { suggestions: ["rynk daemon status", "rynk doctor"] }) });
        stopped.resolve();
      }
    },
  });
  await sub.ready;

  const current = await client.request<Snapshot>("GET", `/api/deployments/${res.deploymentId}`).catch(() => null);
  if (current?.state === "LIVE") {
    live = true;
    resolveOutcome({ ok: true, snap: current });
  } else if (current?.state === "FAILED" && current.error) {
    resolveOutcome({ ok: false, error: new RynkError(current.error.code as never, current.error.message, { causes: current.error.causes, suggestions: current.error.suggestions }) });
  } else if (!stageLabel && current && !quiet) {
    stageLabel = STAGE_LABELS[current.state] ?? current.state;
    spinner.start(stageLabel);
  }

  const stopHosting = async () => {
    say(`\n${c.dim("Stopping…")}`);
    await client.stop(res.projectId).catch(() => undefined);
    popup?.send({ type: "stopped", message: "The app was stopped." });
    closedByUs = true;
    sub.close();
    say(`${sym.ok} Stopped`);
    popup?.close();
    process.exit(0);
  };

  // Keep the popup's live view fresh.
  async function pushStatus() {
    if (!popup?.isWindow || !popup.isOpen || !live) return;
    const [snap, clients] = await Promise.all([
      client.request<Snapshot>("GET", `/api/deployments/${res.deploymentId}`).catch(() => null),
      client.clients(res.projectId).catch(() => null),
    ]);
    popup.send({
      type: "status",
      health: snap?.health ?? "UNKNOWN",
      pid: snap?.pid ?? null,
      ...(snap?.urls ? { urls: snap.urls as unknown as Record<string, string> } : {}),
      users: { active: clients?.active ?? 0, limit: clients?.limit ?? 0 },
      clients: (clients?.sessions ?? []).map((s) => ({ sessionId: s.sessionId, clientAddress: s.clientAddress, status: s.status, connectedAt: s.connectedAt })),
    });
  }

  popup?.on((m) => {
    void (async () => {
      try {
        if (m.type === "action" && m.action === "stop") await stopHosting();
        if (m.type === "action" && m.action === "restart") {
          await client.restart(res.projectId);
          say(`${sym.info} Restarting (requested from the Rynk window)`);
        }
        if (m.type === "action" && m.action === "qr") {
          const snap = await client.request<Snapshot>("GET", `/api/deployments/${res.deploymentId}`);
          const url = shareUrl(snap.urls);
          if (url) popup!.send({ type: "qr", url, matrix: qrMatrix(url) });
        }
        if (m.type === "action" && m.action === "logs") {
          logsToPopup = true;
          for (const e of await client.logs(res.projectId, 100)) popup!.send({ type: "log", line: e.message });
        }
        if (m.type === "disconnect") {
          const s = await client.disconnect(res.projectId, m.sessionId, m.block);
          say(`${sym.info} Disconnected ${s.clientAddress}${m.block ? " (blocked)" : ""}`);
          await pushStatus();
        }
        if (m.type === "limit") {
          await client.setAccess(res.projectId, { maxUsers: m.maxUsers });
          say(`${sym.info} User limit set to ${m.maxUsers || "unlimited"}`);
          await pushStatus();
        }
        if (m.type === "closed" && mode === "detached") {
          closedByUs = true;
          sub.close();
          process.exit(0);
        }
      } catch (e) {
        printError(e);
      }
    })();
  });

  let interrupted = false;
  const onSigint = async () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    spinner.stop();
    if (mode === "detached") {
      say(`\n${c.dim("Detached. The app keeps running in the background — rynk status · rynk stop")}`);
      popup?.close();
      closedByUs = true;
      sub.close();
      process.exit(0);
    }
    await stopHosting();
  };
  process.on("SIGINT", () => void onSigint());
  process.on("SIGTERM", () => void onSigint());

  const result = await outcome;
  spinner.stop();
  if (!result.ok) {
    popup?.send({ type: "failed", message: result.error.message, causes: result.error.causes, suggestions: result.error.suggestions });
    closedByUs = true;
    sub.close();
    printError(result.error, { json: quiet, verbose: Boolean(o.verbose) });
    if (!quiet && result.error.code !== "DAEMON_UNREACHABLE" && req.root === process.cwd()) process.stderr.write(c.dim("Full output: rynk logs\n"));
    if (popup?.isWindow && popup.isOpen) await new Promise<void>((r) => popup!.on((m) => m.type === "closed" && r()));
    return 1;
  }

  const snap = result.snap;
  const url = shareUrl(snap.urls);
  if (quiet) {
    json({
      ok: true, status: "live", project: snap.name, deploymentId: res.deploymentId, projectId: res.projectId,
      host: snap.urls?.network ? new URL(snap.urls.network).hostname : null,
      ip: snap.urls?.network ? new URL(snap.urls.network).hostname : null, port: snap.port, url, urls: snap.urls,
      activeUsers: snap.access?.active ?? 0, maxUsers: snap.access?.maxUsers ?? 0,
      hostingSessionId: snap.hostingSession?.id ?? null, access: snap.access, deployment: snap,
    });
  } else {
    const footer = mode === "foreground"
      ? ["", c.dim("Press Ctrl+C to stop hosting.   rynk clients · rynk share · rynk logs")]
      : ["", c.dim("Running in the background.   rynk clients · rynk share · rynk logs · rynk stop")];
    process.stdout.write("\n" + liveBox(snap, footer) + "\n");
    if (o.qr && url) {
      process.stdout.write(`\n  ${c.dim("Scan to open on a phone on the same network:")}\n`);
      await printQr(url);
    }
    process.stdout.write("\n");
  }
  popup?.send({
    type: "live", name: snap.name ?? "", urls: (snap.urls ?? {}) as unknown as Record<string, string>, port: snap.port ?? 0, pid: snap.pid,
    health: snap.health, uptimeMs: 0, access: { maxUsers: snap.access?.maxUsers ?? 0, mode: snap.access?.mode ?? "open" }, warnings: snap.warnings ?? [],
  });
  void pushStatus();
  const statusTimer = setInterval(() => void pushStatus(), 2000);
  statusTimer.unref();

  if (mode === "detached" && !(popup?.isWindow && popup.isOpen)) {
    closedByUs = true;
    sub.close();
    return 0;
  }
  await stopped.promise;
  clearInterval(statusTimer);
  popup?.send({ type: "stopped", message: "The app stopped." });
  closedByUs = true;
  sub.close();
  if (!interrupted && !quiet) process.stdout.write(`\n${c.dim("Hosting stopped.")}\n`);
  return 0;
}

/** Wait until an already-running deployment finishes starting (or fails), streaming logs unless quiet. */
async function waitUntilSettled(client: RynkClient, projectId: string, quiet: boolean): Promise<void> {
  const state = (await client.project(projectId)).deployment?.state;
  if (!state || state === "LIVE" || state === "FAILED" || state === "STOPPED") return;
  if (!quiet) process.stdout.write(`${sym.info} Already starting (${state}). Waiting for it…\n`);
  await new Promise<void>((resolve) => {
    const sub = client.events({
      projectId,
      onEvent: (e) => {
        const entry = e.payload.entry as LogEntry | undefined;
        if (!quiet && e.type === "log.received" && entry) process.stdout.write(`${c.dim("│")} ${entry.message}\n`);
        if (e.type === "deployment.completed" || e.type === "deployment.failed" || e.type === "runtime.stopped") {
          sub.close();
          resolve();
        }
      },
      onClose: () => resolve(),
    });
    // Re-check after subscribing in case it settled in between.
    void sub.ready.then(async () => {
      const s = (await client.project(projectId)).deployment?.state;
      if (s === "LIVE" || s === "FAILED" || s === "STOPPED") {
        sub.close();
        resolve();
      }
    });
    setTimeout(() => (sub.close(), resolve()), 15 * 60_000).unref();
  });
}

async function attachExisting(client: RynkClient, projectId: string, o: UpOptions, mode: "foreground" | "detached"): Promise<number> {
  await waitUntilSettled(client, projectId, Boolean(o.json));
  const project = await client.project(projectId);
  const dep = project.deployment as Snapshot | null;
  if (dep?.state === "FAILED" && dep.error) {
    printError(new RynkError(dep.error.code as never, dep.error.message, { causes: dep.error.causes, suggestions: dep.error.suggestions }), { json: Boolean(o.json) });
    return 1;
  }
  if (o.json) {
    const url = shareUrl(dep?.urls);
    json({ ok: true, existing: true, status: dep?.state === "LIVE" ? "live" : String(dep?.state ?? "unknown").toLowerCase(), project: project.name, projectId, ip: dep?.urls?.network ? new URL(dep.urls.network).hostname : null, port: dep?.port, url, urls: dep?.urls, access: dep?.access, deployment: dep });
    return 0;
  }
  if (dep?.state === "LIVE") {
    process.stdout.write(liveBox({ ...dep, name: project.name }, ["", c.dim("Already hosting — managed by the daemon.   rynk restart · rynk stop")]) + "\n\n");
    const url = shareUrl(dep.urls);
    if (o.qr && url) await printQr(url);
  } else {
    process.stdout.write(`${sym.info} ${project.name} is already starting (${dep?.state ?? "pending"}). Following its logs…\n`);
  }
  if (mode === "detached" && dep?.state === "LIVE") return 0;
  return new Promise<number>((resolve) => {
    const sub = client.events({
      projectId,
      onEvent: (e) => {
        const entry = e.payload.entry as LogEntry | undefined;
        if (e.type === "log.received" && entry) process.stdout.write(`${c.dim("│")} ${entry.message}\n`);
        if (e.type === "deployment.completed" && mode === "detached") {
          sub.close();
          resolve(0);
        }
        if (e.type === "deployment.failed") {
          sub.close();
          resolve(1);
        }
      },
      onClose: () => resolve(0),
    });
    process.on("SIGINT", () => {
      sub.close();
      resolve(0);
    });
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export { printError };
