import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execa } from "execa";
import { DEFAULTS, paths, RynkError, VERSION } from "@rynk/core";
import { loadRynkYaml, resolveProject } from "@rynk/config";
import { DetectorRegistry } from "@rynk/detector";
import { listInterfaces, primaryInterface } from "@rynk/network";
import { canBind } from "@rynk/ports";
import { toolVersion, which } from "@rynk/process";
import { connect } from "../daemon-control.js";
import { c, json, sym } from "../ui.js";

type Status = "ok" | "warn" | "fail" | "info";
interface Check {
  section: string;
  name: string;
  status: Status;
  detail: string;
  fix?: string[];
}

const RUNTIMES: Array<[string, string, string[]?]> = [
  ["Python", process.platform === "win32" ? "python" : "python3"],
  ["Docker", "docker"],
  ["Java", "java", ["-version"]],
  ["Go", "go", ["version"]],
  ["Rust (cargo)", "cargo"],
  [".NET", "dotnet"],
  ["PHP", "php"],
  ["Ruby", "ruby"],
  ["Deno", "deno"],
  ["Bun", "bun"],
  ["Caddy", "caddy", ["version"]],
  ["cloudflared", "cloudflared"],
];

function selfReach(address: string): Promise<boolean> {
  // Bind 0.0.0.0 on an ephemeral port and connect through the LAN address.
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.end());
    server.once("error", () => resolve(false));
    server.listen(0, "0.0.0.0", () => {
      const port = (server.address() as net.AddressInfo).port;
      const sock = net.connect({ host: address, port, timeout: 1500 });
      const done = (ok: boolean) => {
        sock.destroy();
        server.close();
        resolve(ok);
      };
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      sock.once("timeout", () => done(false));
    });
  });
}

async function firewall(): Promise<Check | null> {
  const section = "Network";
  try {
    if (process.platform === "linux" && which("ufw")) {
      const r = await execa("ufw", ["status"], { reject: false, timeout: 3000 });
      if (/Status: active/i.test(r.stdout)) {
        return { section, name: "Firewall", status: "warn", detail: "ufw is active — other devices may be blocked.", fix: ["sudo ufw allow <share-port>/tcp   # e.g. 5173 — see `rynk ports`", "sudo ufw allow 7779/udp && sudo ufw allow 5353/udp && sudo ufw allow 7780/tcp   # node discovery"] };
      }
      if (r.exitCode === 0) return { section, name: "Firewall", status: "ok", detail: "ufw inactive" };
    }
    if (process.platform === "darwin") {
      const r = await execa("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"], { reject: false, timeout: 3000 });
      if (/enabled/i.test(r.stdout)) {
        return { section, name: "Firewall", status: "info", detail: "macOS firewall is on. Allow incoming connections for \"node\" when macOS asks." };
      }
      if (r.exitCode === 0) return { section, name: "Firewall", status: "ok", detail: "macOS firewall off" };
    }
    if (process.platform === "win32") {
      const r = await execa("netsh", ["advfirewall", "show", "allprofiles", "state"], { reject: false, timeout: 3000, windowsHide: true });
      if (/ON/.test(r.stdout)) {
        return { section, name: "Firewall", status: "info", detail: "Windows Defender Firewall is on. Allow Node.js on Private networks when prompted.", fix: ["Make sure your Wi-Fi network profile is set to Private, not Public."] };
      }
    }
  } catch {
    /* detection is best-effort */
  }
  return { section, name: "Firewall", status: "info", detail: "Couldn't detect firewall state on this platform." };
}

export async function doctor(root: string, opts: { json?: boolean }): Promise<number> {
  const checks: Check[] = [];
  const add = (x: Check) => checks.push(x);

  // ── system ──
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  add({ section: "System", name: "Node.js", status: nodeOk ? "ok" : "fail", detail: `v${process.versions.node}`, ...(nodeOk ? {} : { fix: ["Install Node.js 22.13 or newer (https://nodejs.org)"] }) });
  let sqliteOk = true;
  try {
    await import("node:sqlite");
  } catch {
    sqliteOk = false;
  }
  add({ section: "System", name: "SQLite (node:sqlite)", status: sqliteOk ? "ok" : "fail", detail: sqliteOk ? "available" : "missing", ...(sqliteOk ? {} : { fix: ["Upgrade Node.js to 22.13+"] }) });
  add({ section: "System", name: "Rynk", status: "info", detail: `v${VERSION} — home ${paths.home()}` });

  // ── runtimes ──
  const versions = await Promise.all(RUNTIMES.map(async ([label, bin, args]) => [label, await toolVersion(bin, args)] as const));
  for (const [label, v] of versions) {
    add({ section: "Runtimes", name: label, status: v ? "ok" : "info", detail: v ?? "not installed" });
  }
  if (versions.find(([l]) => l === "Docker")?.[1]) {
    const info = await execa("docker", ["info", "--format", "{{.ServerVersion}}"], { reject: false, timeout: 5000 });
    if (info.exitCode !== 0) add({ section: "Runtimes", name: "Docker engine", status: "warn", detail: "Docker CLI found but the engine isn't reachable.", fix: ["Start Docker Desktop (or the docker service)."] });
  }

  // ── network ──
  const ifaces = listInterfaces();
  const primary = primaryInterface(ifaces);
  if (!primary) {
    add({ section: "Network", name: "LAN interface", status: "warn", detail: "No private network interface found. Only localhost URLs are possible.", fix: ["Connect to Wi-Fi or Ethernet."] });
  } else {
    add({ section: "Network", name: "LAN interface", status: "ok", detail: `${primary.name} (${primary.kind}) ${primary.address}` });
    if (primary.kind === "vpn") add({ section: "Network", name: "VPN", status: "warn", detail: "The best address belongs to a VPN; other devices on your Wi-Fi may not reach it." });
    const reach = await selfReach(primary.address);
    add({ section: "Network", name: "LAN binding", status: reach ? "ok" : "warn", detail: reach ? `0.0.0.0 is reachable via ${primary.address}` : `Couldn't connect to a 0.0.0.0 listener through ${primary.address}.`, ...(reach ? {} : { fix: ["A local firewall may be blocking incoming connections."] }) });
    const others = ifaces.filter((i) => i.address !== primary.address && i.private);
    if (others.length) add({ section: "Network", name: "Other addresses", status: "info", detail: others.map((i) => `${i.address} (${i.name})`).join(", ") });
  }
  const fw = await firewall();
  if (fw) add(fw);

  // ── daemon ──
  const client = await connect();
  if (client) {
    add({ section: "Daemon", name: "Daemon", status: "ok", detail: `running, pid ${client.daemon.pid}, v${client.daemon.version} on ${client.daemon.host}:${client.daemon.port}` });
    add({ section: "Daemon", name: "Name proxy", status: "ok", detail: `http://<name>.localhost:${client.daemon.proxyPort} (this computer only)` });
    const net = await client.network().catch(() => null);
    if (net) {
      const ok = net.discovery.enabled && net.discovery.providers.some((p) => p.ok);
      add({ section: "Network", name: "Node discovery", status: ok ? "ok" : "warn", detail: net.discovery.enabled ? `${net.discovery.providers.map((p) => `${p.name} ${p.ok ? "ok" : "failed"}`).join(", ")}; ${net.discovery.online} other node(s) online` : "disabled (RYNK_DISCOVERY=off)", ...(ok ? {} : { fix: ["Allow UDP 7779 and 5353 (mDNS) for private networks, or check that multicast isn't blocked."] }) });
    }
    if (client.daemon.version !== VERSION) add({ section: "Daemon", name: "Version", status: "warn", detail: `daemon v${client.daemon.version} ≠ CLI v${VERSION}`, fix: ["rynk daemon restart"] });
  } else {
    add({ section: "Daemon", name: "Daemon", status: "info", detail: "not running (starts automatically with `rynk`)" });
    const daemonPort = Number(process.env.RYNK_DAEMON_PORT ?? DEFAULTS.daemonPort);
    const free = await canBind(daemonPort, "127.0.0.1");
    add({ section: "Daemon", name: `Port ${daemonPort}`, status: free ? "ok" : "fail", detail: free ? "free" : "in use by another program", ...(free ? {} : { fix: [`Set RYNK_DAEMON_PORT to a free port.`] }) });
    const proxyFree = await canBind(DEFAULTS.proxyPort, "127.0.0.1");
    add({ section: "Daemon", name: `Port ${DEFAULTS.proxyPort}`, status: proxyFree ? "ok" : "warn", detail: proxyFree ? "free" : "in use — the proxy will pick the next free port" });
  }
  const dbFile = paths.database();
  add({ section: "Daemon", name: "Database", status: "info", detail: fs.existsSync(dbFile) ? dbFile : "not created yet" });

  // ── project ──
  const abs = path.resolve(root);
  try {
    const yaml = loadRynkYaml(abs);
    if (yaml) add({ section: "Project", name: "rynk.yaml", status: "ok", detail: path.basename(yaml.file) + " is valid" });
    const rt = yaml?.config.runtime;
    const prefer = typeof rt === "string" ? rt : rt?.type;
    const report = await new DetectorRegistry().detect(abs, prefer && prefer !== "auto" ? { prefer } : {});
    if (!report.best && !yaml?.config.start) {
      add({ section: "Project", name: "Detection", status: "warn", detail: `Nothing recognisable in ${abs}.`, fix: ['rynk --cmd "<your start command>" --port <port>', "rynk init"] });
    } else {
      const project = resolveProject({ root: abs, yaml: yaml?.config ?? null, detection: report.best });
      add({ section: "Project", name: "Detected", status: "ok", detail: `${project.framework ?? project.language} → ${project.runtime} runtime` });
      add({ section: "Project", name: "Start command", status: project.start.file ? "ok" : "warn", detail: project.start.display || "none" });
      add({ section: "Project", name: "Port", status: "info", detail: project.port ? `${project.port} (explicit)` : project.defaultPort ? `${project.defaultPort} (framework default, auto-allocated if busy)` : "auto" });
      for (const w of report.best?.warnings ?? []) add({ section: "Project", name: "Note", status: "warn", detail: w });
      const needs: Record<string, string> = { python: "Python", docker: "Docker", java: "Java", go: "Go", rust: "Rust (cargo)", dotnet: ".NET", php: "PHP", ruby: "Ruby", deno: "Deno" };
      const want = project.runtime === "docker" || project.runtime === "compose" ? "Docker" : needs[project.language];
      if (want && !versions.find(([l]) => l === want)?.[1]) add({ section: "Project", name: "Runtime", status: "fail", detail: `${want} is required but not installed.` });
      if (client) {
        const views = await client.projects().catch(() => []);
        const mine = views.find((p) => p.root === abs);
        if (mine?.deployment?.state === "LIVE") {
          const lan = await client.request<{ ok: boolean; address?: string; port?: number; error?: string }>("GET", `/api/projects/${mine.id}/lan-check`).catch(() => null);
          if (lan && !lan.ok) {
            add({ section: "Project", name: "LAN access", status: "warn", detail: `The app is healthy locally, but the share link ${lan.address}:${lan.port} didn't answer over the LAN address.`, fix: ["LAN access may be blocked by the operating system firewall. Allow Node.js (or this port) on private networks.", "Rynk never changes firewall settings for you."] });
          } else if (lan?.ok) add({ section: "Project", name: "LAN access", status: "ok", detail: `reachable at ${lan.address}:${lan.port}` });
        }
      }
    }
  } catch (e) {
    const err = RynkError.from(e);
    add({ section: "Project", name: "Configuration", status: "fail", detail: err.message, fix: [...err.causes, ...err.suggestions] });
  }

  const failed = checks.filter((x) => x.status === "fail").length;
  if (opts.json) {
    json({ ok: failed === 0, checks });
    return failed ? 1 : 0;
  }
  const icon: Record<Status, string> = { ok: sym.ok, warn: sym.warn, fail: sym.fail, info: c.dim("·") };
  let section = "";
  process.stdout.write(`\n${c.brand("RYNK")} doctor\n`);
  for (const x of checks) {
    if (x.section !== section) {
      section = x.section;
      process.stdout.write(`\n${c.bold(section)}\n`);
    }
    process.stdout.write(`  ${icon[x.status]} ${x.name.padEnd(22)} ${x.status === "info" ? c.dim(x.detail) : x.detail}\n`);
    for (const f of x.fix ?? []) process.stdout.write(`      ${c.dim("→")} ${f}\n`);
  }
  const warns = checks.filter((x) => x.status === "warn").length;
  process.stdout.write(`\n${failed ? c.err(`${failed} problem(s)`) : c.ok("No blocking problems")}${warns ? c.warn(`, ${warns} warning(s)`) : ""}\n\n`);
  return failed ? 1 : 0;
}
