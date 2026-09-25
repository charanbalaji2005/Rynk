import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { canonicalPath, formatDuration, parseDuration, paths, RynkError, slugify, type LogEntry } from "@rynk/core";
import { loadRynkYaml, renderRynkYaml, resolveProject, CONFIG_FILES } from "@rynk/config";
import { DetectorRegistry } from "@rynk/detector";
import { toolVersion } from "@rynk/process";
import type { ProjectView, RynkClient } from "@rynk/sdk";
import { connect, ensureDaemon, spawnDaemon, stopDaemon } from "../daemon-control.js";
import { up, type UpOptions } from "../run.js";
import { box, c, healthText, json, metricsText, runtimeLabel, stateBadge, sym, table, urlLines, usersText } from "../ui.js";

/** Resolve a project reference: explicit name/id, or the project in the cwd. */
export async function projectRef(client: RynkClient, ref: string | undefined, cwd = process.cwd()): Promise<ProjectView> {
  if (ref) return client.project(ref);
  const abs = canonicalPath(cwd);
  const all = await client.projects();
  const match = all.find((p) => p.root === abs) ?? all.filter((p) => abs.startsWith(p.root + path.sep)).sort((a, b) => b.root.length - a.root.length)[0];
  if (!match) {
    throw new RynkError("NOT_FOUND", "This directory isn't a Rynk project yet.", { suggestions: ["rynk            # host it now", "rynk projects   # list known projects"] });
  }
  return match;
}

async function requireDaemon(): Promise<RynkClient> {
  const client = await connect();
  if (!client) throw new RynkError("DAEMON_UNREACHABLE", "The Rynk daemon isn't running, so nothing is hosted right now.", { suggestions: ["rynk            # host the current project", "rynk daemon start"] });
  return client;
}

// ── status ────────────────────────────────────────────────────
export async function status(ref: string | undefined, o: { json?: boolean; all?: boolean }): Promise<number> {
  const client = await connect();
  if (!client) {
    if (o.json) json({ daemon: null, projects: [] });
    else process.stdout.write(`${c.dim("●")} Daemon not running — nothing is hosted.\n  Start with ${c.bold("rynk")} in a project directory.\n`);
    return 0;
  }
  if (!o.all) {
    const p = await projectRef(client, ref).catch((e) => (ref ? Promise.reject(e) : null));
    if (p) {
      if (o.json) {
        const d = p.deployment;
        const url = d?.urls?.public ?? d?.urls?.network ?? d?.urls?.local ?? null;
        const ip = d?.urls?.network ? new URL(d.urls.network).hostname : null;
        return json({
          status: String(d?.state ?? "never_run").toLowerCase(), project: p.name, host: ip, ip, port: d?.port ?? null, url,
          activeUsers: d?.access?.active ?? 0, maxUsers: d?.access?.maxUsers ?? 0, users: d?.access ? { active: d.access.active, limit: d.access.maxUsers } : null,
          health: d?.health ?? null, pid: d?.pid ?? null, uptimeMs: d?.liveAt && d.state === "LIVE" ? Date.now() - d.liveAt : null,
          hostingSessionId: d?.hostingSession?.id ?? null, ...p,
        }), 0;
      }
      const d = p.deployment;
      const lines = [
        `${c.bold(p.name)}  ${stateBadge(d?.state)}  ${d?.health ? healthText(d.health) : ""}`,
        c.dim(`${[p.framework, runtimeLabel(p.language, p.runtime), p.packageManager].filter(Boolean).join(" · ")} · ${p.root}`),
        "",
        ...(d?.state === "LIVE" ? urlLines(d.urls) : []),
        ...(d?.port ? [`${c.label("Port:   ")} ${d.port}${d.pid ? c.dim(`   pid ${d.pid}`) : ""}${d.containerId ? c.dim(`   container ${d.containerId.slice(0, 12)}`) : ""}`] : []),
        ...(d?.state === "LIVE" && d.hostingSession?.hostAddress ? [`${c.label("Host IP:")} ${d.hostingSession.hostAddress}`] : []),
        ...(d?.state === "LIVE" && d.liveAt ? [`${c.label("Uptime: ")} ${formatDuration(Date.now() - d.liveAt)}${d.restartCount ? c.dim(`   ${d.restartCount} restart(s)`) : ""}`] : []),
        ...(d?.state === "LIVE" ? [`${c.label("Users:  ")} ${usersText(d.access)}`, `${c.label("Usage:  ")} ${metricsText(d.metrics)}`] : []),
        ...(d?.hostingSession ? [c.dim(`hosting session ${d.hostingSession.id}`)] : []),
        ...(d?.error ? ["", `${sym.fail} ${d.error.message}`, ...d.error.suggestions.map((s) => c.dim(`  → ${s}`))] : []),
      ];
      process.stdout.write(box(lines, { title: c.brand("RYNK") }) + "\n");
      return 0;
    }
  }
  return projects({ json: o.json });
}

export async function projects(o: { json?: boolean }): Promise<number> {
  const client = await connect();
  const list = client ? await client.projects() : [];
  if (o.json) return json(list), 0;
  if (!list.length) {
    process.stdout.write(`No projects yet. Run ${c.bold("rynk")} inside a project directory.\n`);
    return 0;
  }
  const rows = list.map((p) => {
    const d = p.deployment;
    const url = d?.state === "LIVE" ? (d.urls?.network ?? d.urls?.local ?? "") : "";
    return [c.bold(p.name), stateBadge(d?.state), p.framework ?? p.language ?? "", d?.port ? String(d.port) : "", url ? c.url(url) : c.dim("—"), c.dim(p.root)];
  });
  process.stdout.write(table(rows, ["NAME", "STATE", "STACK", "PORT", "URL", "PATH"]) + "\n");
  return 0;
}

// ── logs ──────────────────────────────────────────────────────
function formatLog(e: LogEntry, withName?: string): string {
  const t = new Date(e.timestamp).toLocaleTimeString([], { hour12: false });
  const prefix = c.dim(t) + (withName ? ` ${c.brand(withName)}` : "");
  const msg = e.stream === "system" ? c.label(`rynk  ${e.message}`) : e.level === "error" ? c.err(e.message) : e.stream === "stderr" ? c.warn(e.message) : e.message;
  return `${prefix} ${msg}`;
}

export async function logs(ref: string | undefined, o: { follow?: boolean; lines?: string; tail?: string; since?: string; json?: boolean }): Promise<number> {
  const client = await requireDaemon();
  const p = await projectRef(client, ref);
  const limit = Math.min(10_000, Math.max(1, Number(o.tail ?? o.lines ?? 200) || 200));
  let since: number | undefined;
  if (o.since) {
    const ms = parseDuration(o.since, NaN);
    if (!Number.isFinite(ms) || ms <= 0) throw new RynkError("CONFIG_INVALID", `"${o.since}" isn't a duration.`, { suggestions: ["rynk logs --since 30m", "rynk logs --since 2h"] });
    since = Date.now() - ms;
  }
  // --since picks the window; --tail/--lines then keeps the newest N lines of it.
  const entries = (await client.logs(p.id, since ? 10_000 : limit, since)).slice(-limit);
  for (const e of entries) process.stdout.write((o.json ? JSON.stringify(e) : formatLog(e)) + "\n");
  if (!o.follow) return 0;
  return new Promise<number>((resolve) => {
    const sub = client.events({
      projectId: p.id,
      onEvent: (ev) => {
        if (ev.type !== "log.received" || !ev.payload.entry) return;
        process.stdout.write((o.json ? JSON.stringify(ev.payload.entry) : formatLog(ev.payload.entry)) + "\n");
      },
      onClose: () => resolve(0),
    });
    process.on("SIGINT", () => {
      sub.close();
      resolve(0);
    });
  });
}

// ── lifecycle ─────────────────────────────────────────────────
export async function stop(ref: string | undefined, o: { all?: boolean; json?: boolean }): Promise<number> {
  const client = await requireDaemon();
  const targets = o.all ? (await client.projects()).filter((p) => p.deployment && !["STOPPED", "FAILED"].includes(p.deployment.state)) : [await projectRef(client, ref)];
  for (const p of targets) {
    await client.stop(p.id);
    if (!o.json) process.stdout.write(`${sym.ok} Stopped ${c.bold(p.name)}\n`);
  }
  if (o.json) json({ ok: true, stopped: targets.map((t) => t.name) });
  else if (!targets.length) process.stdout.write("Nothing is running.\n");
  return 0;
}

export async function restart(ref: string | undefined, o: { json?: boolean }): Promise<number> {
  const client = await requireDaemon();
  const p = await projectRef(client, ref);
  const r = await client.restart(p.id);
  if (o.json) return json(r), 0;
  process.stdout.write(`${sym.ok} Restarting ${c.bold(p.name)} — follow with ${c.bold(`rynk logs ${p.name} -f`)}\n`);
  return 0;
}

export async function remove(ref: string | undefined, o: { json?: boolean }): Promise<number> {
  const client = await requireDaemon();
  const p = await projectRef(client, ref);
  await client.remove(p.id);
  if (o.json) return json({ ok: true }), 0;
  process.stdout.write(`${sym.ok} Removed ${c.bold(p.name)} from Rynk (your files are untouched)\n`);
  return 0;
}

// ── routes / devices / runtime ────────────────────────────────
export async function routes(o: { json?: boolean }): Promise<number> {
  const client = await connect();
  const list = (client ? await client.routes() : []) as Array<{ name: string; pathPrefix: string; hostnames: string[]; targetHost: string; targetPort: number; lan: boolean }>;
  if (o.json) return json(list), 0;
  if (!list.length) return process.stdout.write("No active routes.\n"), 0;
  const port = client!.daemon.proxyPort;
  process.stdout.write(table(list.map((r) => [c.bold(r.name), `:${port}${r.pathPrefix}/`, r.hostnames.join(", "), `${r.targetHost}:${r.targetPort}`, r.lan ? "LAN" : c.dim("local only")]), ["NAME", "PATH", "HOSTS", "TARGET", "ACCESS"]) + "\n");
  return 0;
}

export async function devices(o: { json?: boolean }): Promise<number> {
  const client = await ensureDaemon();
  const list = (await client.devices()) as Array<{ id: string; hostname: string; os: string; arch: string; cpus: number; memoryBytes: number; status: string; addresses: string[]; lastHeartbeat: number }>;
  if (o.json) return json(list), 0;
  process.stdout.write(table(list.map((d) => [c.bold(d.hostname), d.status === "ONLINE" ? c.ok("● ONLINE") : c.warn(`● ${d.status}`), `${d.os} ${d.arch}`, `${d.cpus} cpu`, d.addresses.join(", "), c.dim(`${formatDuration(Date.now() - d.lastHeartbeat)} ago`)]), ["DEVICE", "STATUS", "OS", "CPU", "ADDRESSES", "HEARTBEAT"]) + "\n");
  process.stdout.write(c.dim("\nOther Rynk machines on your network: rynk nodes\n"));
  return 0;
}

export async function runtime(o: { json?: boolean }): Promise<number> {
  const probes: Array<[string, string, string[]?]> = [
    ["native: node", "node"], ["native: python", process.platform === "win32" ? "python" : "python3"], ["native: go", "go", ["version"]],
    ["native: rust", "cargo"], ["native: java", "java", ["-version"]], ["native: dotnet", "dotnet"], ["native: php", "php"],
    ["native: ruby", "ruby"], ["native: deno", "deno"], ["native: bun", "bun"], ["docker", "docker"], ["compose", "docker", ["compose", "version"]],
  ];
  const res = await Promise.all(probes.map(async ([k, bin, args]) => ({ runtime: k, version: await toolVersion(bin, args) })));
  const detectors = new DetectorRegistry().list();
  if (o.json) return json({ runtimes: res, detectors }), 0;
  process.stdout.write(table(res.map((r) => [r.runtime, r.version ? c.ok(r.version) : c.dim("not installed")]), ["RUNTIME", "VERSION"]) + "\n");
  process.stdout.write(`\n${c.dim("Detectors:")} ${detectors.join(", ")}\n${c.dim("Static sites and custom commands (--cmd) work without extra tools.")}\n`);
  return 0;
}

// ── init ──────────────────────────────────────────────────────
export async function init(root: string, o: { force?: boolean; json?: boolean }): Promise<number> {
  const abs = path.resolve(root);
  const existing = CONFIG_FILES.map((f) => path.join(abs, f)).find((f) => fs.existsSync(f));
  if (existing && !o.force) {
    throw new RynkError("CONFIG_INVALID", `${path.basename(existing)} already exists.`, { suggestions: ["rynk init --force   # overwrite it"] });
  }
  const yaml = existing ? loadRynkYaml(abs)?.config ?? null : null;
  const report = await new DetectorRegistry().detect(abs);
  if (!report.best) {
    throw new RynkError("DETECTION_FAILED", "Rynk couldn't recognise this project, so there's nothing to pre-fill.", {
      suggestions: ["Create rynk.yaml with at least:  start: { command: \"./my-server\" }", "See docs/rynk-yaml.md"],
    });
  }
  const project = resolveProject({ root: abs, detection: report.best, yaml });
  const file = path.join(abs, "rynk.yaml");
  fs.writeFileSync(file, renderRynkYaml(project));
  if (o.json) return json({ ok: true, file, project }), 0;
  process.stdout.write(`${sym.ok} Wrote ${c.bold("rynk.yaml")} for ${project.framework ?? project.language} (${report.best.evidence.slice(0, 2).join(", ")})\n  Edit it to override anything Rynk detected; run ${c.bold("rynk")} to host.\n`);
  return 0;
}

// ── daemon ────────────────────────────────────────────────────
export async function daemon(action: string, o: { json?: boolean }): Promise<number> {
  switch (action) {
    case "start": {
      const existing = await connect();
      const client = existing ?? (await spawnDaemon());
      if (o.json) return json(client.daemon), 0;
      process.stdout.write(`${sym.ok} Daemon ${existing ? "already running" : "started"} (pid ${client.daemon.pid}) on ${client.daemon.host}:${client.daemon.port}, proxy :${client.daemon.proxyPort}\n`);
      return 0;
    }
    case "stop": {
      const was = await stopDaemon();
      if (!o.json) process.stdout.write(was ? `${sym.ok} Daemon stopped. Running deployments were stopped and will be restored next start.\n` : "Daemon wasn't running.\n");
      else json({ ok: true, wasRunning: was });
      return 0;
    }
    case "restart": {
      await stopDaemon();
      const client = await spawnDaemon();
      if (o.json) return json(client.daemon), 0;
      process.stdout.write(`${sym.ok} Daemon restarted (pid ${client.daemon.pid})\n`);
      return 0;
    }
    case "status": {
      const client = await connect();
      if (!client) {
        if (o.json) json({ running: false });
        else process.stdout.write(`${c.dim("●")} Daemon not running\n`);
        return 0;
      }
      const info = (await client.info()) as { uptimeMs: number; activeDeployments: number; memoryBytes: number; network: { primary: { address: string } | null } };
      if (o.json) return json({ running: true, ...client.daemon, token: undefined, ...info }), 0;
      process.stdout.write(`${c.ok("●")} Daemon running  pid ${client.daemon.pid}  v${client.daemon.version}  up ${formatDuration(info.uptimeMs)}\n  API   http://${client.daemon.host}:${client.daemon.port}\n  Proxy :${client.daemon.proxyPort}${info.network.primary ? `  (LAN ${info.network.primary.address})` : ""}\n  Active deployments: ${info.activeDeployments}\n  Log   ${paths.daemonLog()}\n`);
      return 0;
    }
    case "logs": {
      const file = paths.daemonLog();
      if (!fs.existsSync(file)) return process.stdout.write("No daemon log yet.\n"), 0;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-100);
      for (const l of lines) {
        try {
          const e = JSON.parse(l) as LogEntry;
          process.stdout.write(`${c.dim(new Date(e.timestamp).toLocaleTimeString([], { hour12: false }))} ${e.level === "error" ? c.err(e.level) : e.level === "warn" ? c.warn(e.level) : c.dim(e.level)} [${e.source}] ${e.message}\n`);
        } catch {
          process.stdout.write(l + "\n");
        }
      }
      return 0;
    }
    default:
      throw new RynkError("CONFIG_INVALID", `Unknown daemon action "${action}".`, { suggestions: ["rynk daemon start|stop|restart|status|logs"] });
  }
}

// ── deploy (path or git) ──────────────────────────────────────
export async function confirm(q: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} ${c.dim("[y/N]")} `)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

export function parseGitSource(src: string): { url: string; slug: string; ref?: string } | null {
  const [base, ref] = src.split("#") as [string, string | undefined];
  let url: string | null = null;
  const gh = /^(github|gitlab|bitbucket):([\w.-]+)\/([\w.-]+)$/.exec(base);
  if (gh) url = `https://${gh[1] === "bitbucket" ? "bitbucket.org" : `${gh[1]}.com`}/${gh[2]}/${gh[3]}.git`;
  else if (/^(https?:\/\/|git@|ssh:\/\/)/.test(base) && (/\.git$/.test(base) || /github\.com|gitlab\.com|bitbucket\.org/.test(base))) url = base;
  if (!url) return null;
  const slug = slugify(url.replace(/^.*[/:]([^/]+\/[^/]+?)(\.git)?$/, "$1").replace("/", "-"));
  return { url, slug, ...(ref ? { ref } : {}) };
}

export async function deploy(source: string | undefined, o: UpOptions & { device?: string; yes?: boolean }): Promise<number> {
  if (o.device && !["local", "auto", "this"].includes(o.device)) {
    throw new RynkError("NOT_FOUND", `Device "${o.device}" isn't available.`, {
      causes: ["Remote devices need the Rynk control plane, which isn't part of this release."],
      suggestions: ["rynk devices", "rynk deploy --device local", "See docs/multi-device.md"],
    });
  }
  let root = source ?? process.cwd();
  const git = source ? parseGitSource(source) : null;
  if (git) {
    // Remote code is untrusted: never build/run it without an explicit yes.
    if (!o.yes) {
      if (!process.stdin.isTTY || o.json) {
        throw new RynkError("COMMAND_REJECTED", "Deploying a remote repository runs its code on this machine.", { suggestions: [`rynk deploy ${source} --yes`] });
      }
      process.stdout.write(`${sym.warn} ${c.warn("This will clone")} ${c.bold(git.url)} ${c.warn("and run its install/build/start commands on this machine.")}\n`);
      if (!(await confirm("Continue?"))) return 1;
    }
    const dest = path.join(paths.home(), "sources", git.slug);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const run = (args: string[], cwd?: string) => {
      const r = spawnSync("git", args, { cwd, stdio: o.json ? "ignore" : "inherit", windowsHide: true });
      if (r.error || r.status !== 0) throw new RynkError("INSTALL_FAILED", `git ${args[0]} failed.`, { suggestions: ["Check the repository URL and your git credentials.", "git --version"] });
    };
    if (fs.existsSync(path.join(dest, ".git"))) {
      run(["fetch", "--depth", "1", "origin", git.ref ?? "HEAD"], dest);
      run(["reset", "--hard", "FETCH_HEAD"], dest);
    } else {
      run(["clone", "--depth", "1", ...(git.ref ? ["--branch", git.ref] : []), git.url, dest]);
    }
    root = dest;
    o.name = o.name ?? git.slug;
  } else if (!fs.existsSync(root)) {
    throw new RynkError("NOT_FOUND", `Directory not found: ${root}`);
  }
  return up(root, o, "detached");
}

/** `rynk hosting`: hosting sessions (current and past) — one per period a project was shared. */
export async function hosting(ref: string | undefined, o: { json?: boolean; all?: boolean }): Promise<number> {
  const client = await requireDaemon();
  const projectId = ref ? (await projectRef(client, ref)).id : undefined;
  const list = await client.hostingSessions(projectId, o.all ? 500 : 20);
  if (o.json) return json(list), 0;
  if (!list.length) return process.stdout.write("No hosting sessions yet.\n"), 0;
  const st = (s: string) => (s === "live" ? c.ok("● live") : s === "failed" ? c.err("● failed") : s === "stopped" ? c.dim("○ stopped") : c.warn(`● ${s}`));
  process.stdout.write(table(list.map((h) => [
    c.bold(h.projectName), st(h.status), h.shareUrl ? c.url(h.shareUrl) : c.dim("—"), `${h.peakUsers}/${h.maxUsers || "∞"}`,
    new Date(h.createdAt).toLocaleString(), h.endedAt ? formatDuration(h.endedAt - h.createdAt) : c.dim("running"), c.dim(h.id),
  ]), ["PROJECT", "STATUS", "SHARE LINK", "PEAK USERS", "STARTED", "DURATION", "SESSION"]) + "\n");
  return 0;
}
