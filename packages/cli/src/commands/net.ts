import net from "node:net";
import { canonicalPath, formatDuration, RynkError } from "@rynk/core";
import type { RynkClient } from "@rynk/sdk";
import { connect, ensureDaemon } from "../daemon-control.js";
import { box, c, healthText, json, runtimeLabel, shareUrl, stateBadge, sym, table, usersText } from "../ui.js";
import { ago } from "../ui.js";
import { projectRef } from "./manage.js";

const nodeStatus = (s: string) => (s === "ONLINE" ? c.ok("● ONLINE") : s === "UNREACHABLE" ? c.warn("● UNREACHABLE") : c.dim("○ OFFLINE"));

async function fresh(client: RynkClient) {
  // A quick active query so a freshly started daemon doesn't show an empty network.
  return client.refreshNodes().catch(() => client.nodes());
}

/** `rynk nodes`: Rynk machines on this network (discovered automatically). */
export async function nodes(o: { json?: boolean }): Promise<number> {
  const client = await ensureDaemon({ quiet: true });
  const list = await fresh(client);
  if (o.json) return json(list), 0;
  process.stdout.write(table(list.map((n) => [
    c.bold(n.name) + (n.self ? c.dim(" (this computer)") : ""),
    n.address,
    nodeStatus(n.status),
    String(n.apps.length),
    [n.platform, n.arch].filter(Boolean).join("/"),
    n.self ? "" : c.dim(ago(n.lastSeen)),
  ]), ["NODE", "IP", "STATUS", "APPS", "PLATFORM", "SEEN"]) + "\n");
  if (list.length === 1) process.stdout.write(c.dim("\nNo other Rynk nodes found yet. Run `npx rynk` on another computer on this network.\n"));
  return 0;
}

/** `rynk apps`: every app hosted by any Rynk node on this network. */
export async function apps(o: { json?: boolean }): Promise<number> {
  const client = await ensureDaemon({ quiet: true });
  await fresh(client);
  const list = await client.apps();
  if (o.json) return json(list), 0;
  if (!list.length) {
    process.stdout.write(`No apps are being shared on this network yet.\nHost one with ${c.bold("rynk")} in a project folder.\n`);
    return 0;
  }
  const byNode = new Map<string, typeof list>();
  for (const a of list) byNode.set(a.node.nodeId, [...(byNode.get(a.node.nodeId) ?? []), a]);
  process.stdout.write(`${c.bold("Rynk network")}\n`);
  for (const group of byNode.values()) {
    const n = group[0]!.node;
    process.stdout.write(`\n${n.status === "ONLINE" ? c.ok("●") : c.dim("○")} ${c.bold(n.name)}${n.self ? c.dim(" (this computer)") : ""}  ${c.dim(n.address)}\n`);
    for (const a of group) {
      process.stdout.write(`    ${a.name.padEnd(22)} ${c.url(a.url)}  ${c.dim([a.framework, a.access === "protected" ? "invite only" : ""].filter(Boolean).join(" · "))}\n`);
    }
  }
  return 0;
}

/** `rynk network`: interfaces, the chosen address and discovery state. */
export async function network(o: { json?: boolean }): Promise<number> {
  const client = await ensureDaemon({ quiet: true });
  const v = await client.network();
  if (o.json) return json(v), 0;
  process.stdout.write(`${c.bold("Network")}\n\n`);
  const kindLabel: Record<string, string> = { wifi: "Wi-Fi", ethernet: "Ethernet", vpn: "VPN", virtual: "virtual", unknown: "other" };
  process.stdout.write(table(v.interfaces.map((i) => [
    i.address === v.primary?.address ? c.ok("✓") : " ",
    kindLabel[i.kind] ?? i.kind,
    i.name,
    i.address,
    i.address === v.primary?.address ? c.dim("used for share links") : "",
  ]), ["", "TYPE", "INTERFACE", "IP", ""]) + "\n");
  if (!v.primary) process.stdout.write(`\n${sym.warn} No network connection found — links will only work on this computer.\n`);
  process.stdout.write(`\n${c.bold("Discovery")}  ${v.discovery.enabled ? v.discovery.providers.map((p) => (p.ok ? `${sym.ok} ${p.name}` : `${sym.fail} ${p.name} ${c.dim(p.error ?? "")}`)).join("   ") : c.dim("off (RYNK_DISCOVERY=off)")}\n`);
  process.stdout.write(`${c.label("Nodes seen:")} ${v.discovery.online} online / ${v.discovery.nodes} total${v.node ? c.dim(`   this node: ${v.node.name} (${v.node.nodeId.slice(0, 18)}…)`) : ""}\n`);
  process.stdout.write(c.dim("\nPick a different interface with: rynk --network <name|ip>\n"));
  return 0;
}

function tcpReach(host: string, port: number, ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: ms });
    const done = (ok: boolean) => (s.destroy(), resolve(ok));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.once("timeout", () => done(false));
  });
}

/** `rynk network test`: verify every hop from IP detection to node communication. */
export async function networkTest(o: { json?: boolean }): Promise<number> {
  const client = await ensureDaemon({ quiet: true });
  const v = await client.network();
  const checks: Array<{ name: string; ok: boolean | null; detail: string; fix?: string }> = [];
  const add = (name: string, ok: boolean | null, detail: string, fix?: string) => checks.push({ name, ok, detail, ...(fix ? { fix } : {}) });

  add("IP detected", Boolean(v.primary), v.primary ? `${v.primary.address} on ${v.primary.name}` : "no LAN address", v.primary ? undefined : "Connect to Wi-Fi or Ethernet.");
  if (v.primary) {
    const server = net.createServer((s) => s.end()).listen(0, "0.0.0.0");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as net.AddressInfo).port;
    const ok = await tcpReach(v.primary.address, port);
    server.close();
    add("LAN binding", ok, ok ? "0.0.0.0 listeners are reachable via the LAN address" : "couldn't reach a 0.0.0.0 listener via the LAN address", ok ? undefined : "A local firewall may be blocking incoming connections.");
  }
  const projects = (await client.projects()).filter((p) => p.deployment?.state === "LIVE");
  if (!projects.length) add("Hosted apps", null, "nothing hosted — start one with `rynk` to test it end to end");
  for (const p of projects) {
    const d = p.deployment!;
    const local = d.port ? await tcpReach("127.0.0.1", d.port) : false;
    add(`${p.name}: port ${d.port}`, local, local ? "accepting connections on this computer" : "not accepting connections");
    const lan = await client.lanCheck(p.id).catch(() => null);
    if (lan) {
      add(`${p.name}: share link`, lan.ok, lan.ok ? `responds at ${lan.address}:${lan.port}` : `no response at ${lan.address ?? "?"}:${lan.port ?? "?"}`,
        lan.ok ? undefined : "The app is healthy locally; LAN access may be blocked by the OS firewall. Allow Node.js / this port for private networks.");
    }
  }
  const disc = v.discovery;
  add("Discovery", disc.enabled && disc.providers.some((p) => p.ok), disc.enabled ? disc.providers.map((p) => `${p.name} ${p.ok ? "ok" : "failed"}`).join(", ") : "disabled");
  if (v.node && v.primary) {
    const r = await fetch(`http://${v.primary.address}:${v.node.apiPort}/rynk/v1/node`, { signal: AbortSignal.timeout(2000) }).then((x) => x.ok, () => false);
    add("Node communication", r, r ? `node info reachable at ${v.primary.address}:${v.node.apiPort}` : "this node's info endpoint isn't reachable over the LAN address", r ? undefined : `Allow TCP ${v.node.apiPort} and UDP 7779 / 5353 for discovery.`);
  }
  const others = (await client.refreshNodes().catch(() => [])).filter((n) => !n.self);
  add("Other nodes", others.length ? others.every((n) => n.status === "ONLINE") : null, others.length ? others.map((n) => `${n.name} ${n.status.toLowerCase()}`).join(", ") : "none seen yet (fine if this is the only Rynk computer)");

  const failed = checks.filter((x) => x.ok === false).length;
  if (o.json) return json({ ok: failed === 0, checks }), failed ? 1 : 0;
  process.stdout.write(`\n${c.bold("Rynk network test")}\n\n`);
  for (const x of checks) {
    process.stdout.write(`  ${x.ok === true ? sym.ok : x.ok === false ? sym.fail : c.dim("·")} ${x.name.padEnd(26)} ${x.ok === null ? c.dim(x.detail) : x.detail}\n`);
    if (x.fix) process.stdout.write(`      ${c.dim("→")} ${x.fix}\n`);
  }
  process.stdout.write(`\n${failed ? c.err(`${failed} check(s) failed`) : c.ok("All checks passed")}\n`);
  return failed ? 1 : 0;
}

/** `rynk ports`: which ports Rynk is using and why. */
export async function ports(o: { json?: boolean }): Promise<number> {
  const client = await connect();
  if (!client) {
    if (o.json) return json({ apps: [] }), 0;
    process.stdout.write("Nothing is hosted; Rynk isn't using any ports.\n");
    return 0;
  }
  const v = await client.ports();
  if (o.json) return json(v), 0;
  const rows = v.apps.map((a) => [String(a.sharePort ?? "—"), c.bold(a.name), stateBadge(a.state), a.bind === "0.0.0.0" ? "network" : a.bind === "127.0.0.1" ? "this computer" : (a.bind ?? "direct"), a.appPort && a.appPort !== a.sharePort ? c.dim(`app on 127.0.0.1:${a.appPort}`) : ""]);
  if (rows.length) process.stdout.write(table(rows, ["PORT", "PROJECT", "STATE", "REACHABLE FROM", "INTERNAL"]) + "\n");
  else process.stdout.write(c.dim("No apps are hosted.\n"));
  process.stdout.write(c.dim(`\nRynk itself: daemon 127.0.0.1:${client.daemon.port}, name proxy 127.0.0.1:${v.proxy}${v.node ? `, node info :${v.node} (read-only)` : ""}, discovery UDP 7779 + mDNS 5353\n`));
  return 0;
}

/** `rynk inspect`: everything Rynk knows about one project. */
export async function inspect(ref: string | undefined, o: { json?: boolean }): Promise<number> {
  const client = await connect();
  if (!client) throw new RynkError("DAEMON_UNREACHABLE", "Nothing is hosted. Use `rynk plan` to see what Rynk would do here.", { suggestions: ["rynk plan"] });
  const p = await projectRef(client, ref);
  const d = p.deployment;
  const v = d?.state === "LIVE" ? await client.clients(p.id).catch(() => null) : null;
  const net = await client.network().catch(() => null);
  if (o.json) return json({ project: p, clients: v, network: net?.primary ?? null }), 0;
  const def = p.definition;
  const rows: Array<[string, string]> = [
    ["Project", `${p.name}  ${c.dim(p.root)}`],
    ["Framework", p.framework ?? c.dim("—")],
    ["Runtime", `${runtimeLabel(p.language, p.runtime)} ${c.dim(`(${p.runtime})`)}`],
    ["Package manager", p.packageManager ?? c.dim("—")],
    ["Install", def.install?.map((x) => x.display).join(" && ") || c.dim("—")],
    ["Build", def.build?.map((x) => x.display).join(" && ") || c.dim("—")],
    ["Start command", d?.command ?? def.start.display],
    ["Share port", d?.port ? String(d.port) : c.dim("—")],
    ["App listens on", d?.appPort ? `127.0.0.1:${d.appPort}` : c.dim("—")],
    ["Bound to", def.exposure === "local" ? "127.0.0.1 (this computer)" : def.host === "0.0.0.0" || !def.host ? "0.0.0.0 (all networks)" : def.host],
    ["IP / interface", net?.primary ? `${net.primary.address} (${net.primary.name})` : c.dim("none")],
    ["Share link", shareUrl(d?.urls) ?? c.dim("—")],
    ["Exposure", def.exposure + (d?.urls?.public ? " + public tunnel" : "")],
    ["Access", `${def.access.mode === "protected" ? "invite only" : "anyone with the link"}, max ${def.access.maxUsers || "unlimited"} users, idle after ${formatDuration(def.access.idleTimeoutMs)}`],
    ["Active users", d?.state === "LIVE" ? usersText(d.access) : c.dim("—")],
    ["Health", `${healthText(d?.health)} ${c.dim(`(${def.health.type}${def.health.type === "http" ? ` ${def.health.path ?? "/"}` : ""})`)}`],
    ["State", stateBadge(d?.state)],
    ["Process", d?.pid ? `pid ${d.pid}` : d?.containerId ? `container ${d.containerId.slice(0, 12)}` : c.dim("—")],
    ["Restarts", `${d?.restartCount ?? 0} ${c.dim(`(policy ${def.restart.policy}, max ${def.restart.maxRetries})`)}`],
    ["Discovery", def.access.advertise && def.exposure !== "local" ? "advertised to other Rynk nodes" : "not advertised"],
    ["Settings from", def.source.join(" → ")],
    ["Host control", p.capabilities ? capText(p.capabilities) : c.dim("—")],
    ["Gateway", d?.access?.managed ? `on :${d.port} → 127.0.0.1:${d.appPort} (rate-limited, ${def.access.maxUsers || "∞"} users)` : c.dim(d?.state === "LIVE" ? "not used (Compose publishes its own ports)" : "—")],
    ["Hosting session", d?.hostingSession ? `${d.hostingSession.id} (${d.hostingSession.status}, peak ${d.hostingSession.peakUsers} users)` : c.dim("—")],
  ];
  process.stdout.write(box(rows.map(([k, val]) => `${c.label(k.padEnd(16))} ${val}`), { title: c.brand("RYNK INSPECT") }) + "\n");
  if (v?.sessions.length) process.stdout.write(c.dim(`\n${v.sessions.length} client session(s) — rynk clients ${p.name}\n`));
  return 0;
}

/** `rynk plan`: show exactly what would happen, without doing anything. */
export async function plan(dir: string, o: { json?: boolean; runtime?: string; cmd?: string; port?: string; name?: string; network?: string; local?: boolean; maxUsers?: string }): Promise<number> {
  const client = await ensureDaemon({ quiet: true });
  const pl = await client.plan(canonicalPath(dir), { runtime: o.runtime, command: o.cmd, port: o.port, name: o.name, network: o.network, exposure: o.local ? "local" : undefined, maxUsers: o.maxUsers });
  if (o.json) return json(pl), pl.project ? 0 : 1;
  if (!pl.project) {
    process.stdout.write(`${sym.fail} ${pl.error?.message ?? "Nothing to host here."}\n`);
    for (const s of pl.error?.suggestions ?? []) process.stdout.write(`  ${c.bold(s)}\n`);
    return 1;
  }
  const p = pl.project;
  const lines = [
    `${c.label("Framework:      ")} ${p.framework ?? c.dim("—")}`,
    `${c.label("Runtime:        ")} ${runtimeLabel(p.language, p.runtime)}`,
    `${c.label("Package manager:")} ${pl.packageManager ?? c.dim("—")}`,
    "",
    `${c.label("Install:        ")} ${p.install?.map((x) => x.display).join(" && ") || c.dim("nothing")}`,
    `${c.label("Build:          ")} ${p.build?.map((x) => x.display).join(" && ") || c.dim("nothing")}`,
    `${c.label("Start:          ")} ${p.start.display}${p.binding.args?.length ? c.dim(` ${p.binding.args.join(" ").replace("{host}", "127.0.0.1").replace("{port}", "<internal>")}`) : ""}`,
    "",
    `${c.label("Network:        ")} ${pl.network ? `${pl.network.name} (${pl.network.kind})` : c.dim("none")}`,
    `${c.label("IP:             ")} ${pl.network?.address ?? c.dim("—")}`,
    `${c.label("Port:           ")} ${pl.sharePort ?? "auto"}${p.defaultPort && pl.sharePort && pl.sharePort !== p.defaultPort ? c.dim(` (${p.defaultPort} is busy)`) : ""}`,
    `${c.label("Share link:     ")} ${pl.shareUrl ?? c.dim("—")}`,
    `${c.label("Exposure:       ")} ${p.exposure.toUpperCase()}`,
    `${c.label("Access:         ")} ${p.access.mode === "protected" ? "invite only" : "anyone with the link"}, max ${p.access.maxUsers || "unlimited"} users`,
    `${c.label("Health check:   ")} ${p.health.type}${p.health.type === "http" ? ` ${p.health.path ?? "/"}` : ""}`,
    `${c.label("Auto restart:   ")} ${p.restart.policy}`,
    ...(pl.capabilities ? [`${c.label("Host control:   ")} ${capText(pl.capabilities)}`] : []),
  ];
  for (const w of pl.best?.warnings ?? []) lines.push(`${sym.warn} ${c.warn(w)}`);
  process.stdout.write(box(lines, { title: c.brand("RYNK PLAN") }) + `\n${c.dim(pl.running ? `Already ${pl.running.toLowerCase()} — no changes executed.` : "No changes executed.")}\n`);
  return 0;
}

/** Human summary of RuntimeCapabilities. */
function capText(k: { supportsHostFlag: boolean; supportsPortFlag: boolean; supportsHostEnv: boolean; supportsPortEnv: boolean; supportsHealthCheck: boolean }): string {
  const how = [
    k.supportsHostFlag || k.supportsPortFlag ? `flags (${[k.supportsHostFlag && "host", k.supportsPortFlag && "port"].filter(Boolean).join(", ")})` : "",
    k.supportsHostEnv || k.supportsPortEnv ? `env (${[k.supportsHostEnv && "HOST", k.supportsPortEnv && "PORT"].filter(Boolean).join(", ")})` : "",
  ].filter(Boolean);
  return `${how.join(" + ") || "none — port discovered from the app"}${k.supportsHealthCheck ? "" : c.dim(", no health probe")}`;
}
