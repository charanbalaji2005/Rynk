import { spawn } from "node:child_process";
import { formatDuration, parseDuration, RynkError } from "@rynk/core";
import { connect } from "../daemon-control.js";
import { printQr } from "../run.js";
import { c, copyToClipboard, json, shareUrl, sym, table, usersText } from "../ui.js";
import { ago } from "../ui.js";
import { confirm, projectRef } from "./manage.js";

async function requireDaemon() {
  const client = await connect();
  if (!client) throw new RynkError("DAEMON_UNREACHABLE", "Nothing is being hosted right now (the Rynk daemon isn't running).", { suggestions: ["rynk            # host the current project"] });
  return client;
}

export interface ShareOptions {
  public?: boolean;
  provider?: string;
  stop?: boolean;
  qr?: boolean;
  json?: boolean;
  yes?: boolean;
  invite?: boolean;
  expires?: string;
  uses?: string;
  revoke?: string;
  open?: boolean;
  copy?: boolean;
}

/** `rynk share`: the current share link, QR and users — plus invites and the public tunnel. */
export async function share(ref: string | undefined, o: ShareOptions): Promise<number> {
  const client = await requireDaemon();
  const p = await projectRef(client, ref);

  if (o.stop) {
    await client.unshare(p.id);
    if (o.json) return json({ ok: true }), 0;
    process.stdout.write(`${sym.ok} Public link for ${c.bold(p.name)} closed. The LAN link still works.\n`);
    return 0;
  }
  if (o.revoke) {
    await client.revokeInvite(p.id, o.revoke);
    if (o.json) return json({ ok: true }), 0;
    process.stdout.write(`${sym.ok} Invite ${o.revoke} revoked. Sessions already using it continue until you disconnect them.\n`);
    return 0;
  }
  if (o.invite) {
    const ttlMs = parseDuration(o.expires ?? "1h", 3_600_000);
    const maxUses = Math.max(1, Number(o.uses ?? 10) || 10);
    const inv = await client.invite(p.id, { ttlMs, maxUses });
    if (o.json) return json(inv), 0;
    process.stdout.write(`\n${c.bold("Invite link")} for ${c.bold(p.name)} ${c.dim(`(expires in ${formatDuration(ttlMs)}, ${maxUses} uses, id ${inv.id})`)}\n\n  ${c.url(inv.url)}\n\n`);
    if (o.qr !== false) await printQr(inv.url);
    process.stdout.write(c.dim(`\nThe app is now invite-only; people already connected keep access.\nRevoke with: rynk share ${p.name} --revoke ${inv.id}\n`));
    return 0;
  }
  if (o.public) {
    if (!o.yes && process.stdin.isTTY && !o.json) {
      process.stdout.write(`${sym.warn} ${c.warn("This makes")} ${c.bold(p.name)} ${c.warn("reachable by anyone on the internet who has the link.")}\n`);
      if (!(await confirm("Create a public link?"))) return 1;
    }
    const r = await client.share(p.id, { public: true, ...(o.provider ? { provider: o.provider } : {}) });
    if (o.json) return json(r), 0;
    process.stdout.write(`\n${c.warn("Public")} link for ${c.bold(p.name)}:\n\n  ${c.url(r.url)}\n\n`);
    if (o.qr !== false) await printQr(r.url);
    process.stdout.write(`\n${c.dim(`User limits and invites apply here too. Close it with: rynk share ${p.name} --stop`)}\n`);
    return 0;
  }

  const d = p.deployment;
  if (d?.state !== "LIVE") throw new RynkError("NOT_FOUND", `${p.name} isn't live right now.`, { suggestions: ["rynk start", "rynk status"] });
  const url = shareUrl(d.urls);
  const copied = o.copy && url ? await copyToClipboard(url) : false;
  if (o.json) return json({ status: "live", project: p.name, url, urls: d.urls, activeUsers: d.access?.active ?? 0, maxUsers: d.access?.maxUsers ?? 0, users: d.access ? { active: d.access.active, limit: d.access.maxUsers } : null, access: d.access, copied }), 0;
  process.stdout.write(`\n${c.ok("● LIVE")}  ${c.bold(p.name)}\n\n  ${c.label("Share link")}    ${c.url(url ?? "")}\n  ${c.label("Active users")}  ${usersText(d.access)}\n`);
  if (!d.urls?.network) process.stdout.write(`  ${sym.warn} ${c.warn("No network link (local mode or no network). Only this computer can open it.")}\n`);
  if (o.copy) process.stdout.write(copied ? `  ${sym.ok} Copied to the clipboard\n` : `  ${sym.warn} ${c.warn("No clipboard tool found (install wl-copy, xclip or xsel on Linux).")}\n`);
  process.stdout.write("\n");
  if (o.qr !== false && url) await printQr(url);
  if (o.open && url) openBrowser(url);
  return 0;
}

/** `rynk clients`: who is connected to a hosted app right now. */
export async function clients(ref: string | undefined, o: { json?: boolean }): Promise<number> {
  const client = await requireDaemon();
  const p = await projectRef(client, ref);
  const v = await client.clients(p.id);
  if (o.json) return json(v), 0;
  process.stdout.write(`${c.bold(v.name)}  ${c.url(v.shareUrl ?? "")}\n\n`);
  if (!v.managed) {
    process.stdout.write(`${sym.info} Client tracking isn't available for this project (Compose publishes its ports directly).\n`);
    return 0;
  }
  if (!v.sessions.length) process.stdout.write(c.dim("No one is connected.\n"));
  else {
    const rows = v.sessions.map((s, i) => [
      String(i + 1),
      s.clientAddress,
      s.status === "active" ? c.ok("● ACTIVE") : c.dim("○ IDLE"),
      c.dim(new Date(s.connectedAt).toLocaleTimeString([], { hour12: false })),
      c.dim(ago(s.lastSeenAt)),
      s.openConnections ? String(s.openConnections) : "",
      c.dim(s.sessionId),
    ]);
    process.stdout.write(table(rows, ["#", "ADDRESS", "STATUS", "SINCE", "LAST SEEN", "OPEN", "SESSION"]) + "\n");
  }
  process.stdout.write(`\n${c.label("Active:")} ${v.active} / ${v.limit || "∞"}   ${c.label("Access:")} ${v.access?.mode === "protected" ? "invite only" : "anyone with the link"}\n`);
  if (v.blocked.length) process.stdout.write(`${c.label("Blocked:")} ${v.blocked.join(", ")}\n`);
  const liveInvites = v.invites.filter((i) => !i.revoked && i.expiresAt > Date.now());
  if (liveInvites.length) process.stdout.write(`${c.label("Invites:")} ${liveInvites.map((i) => `${i.id} (${i.uses}/${i.maxUses} used)`).join(", ")}\n`);
  process.stdout.write(c.dim(`\nrynk clients disconnect <session> [--block] · rynk limit <n>\nPrivacy: addresses are what this computer sees on the connection (NAT/VPN devices may share one). They're kept in memory\nonly, never sent to other nodes, and forgotten ${Math.round(v.retentionMs / 60000)} min after a visitor goes idle (RYNK_CLIENT_RETENTION).\n`));
  return 0;
}

export async function disconnect(sessionId: string, o: { project?: string; block?: boolean; json?: boolean }): Promise<number> {
  const client = await requireDaemon();
  // Find the project owning this session when not specified.
  let projectId = o.project ? (await projectRef(client, o.project)).id : undefined;
  if (!projectId) {
    for (const p of await client.projects()) {
      if (p.deployment?.state !== "LIVE") continue;
      const v = await client.clients(p.id).catch(() => null);
      if (v?.sessions.some((s) => s.sessionId === sessionId)) projectId = p.id;
    }
  }
  if (!projectId) throw new RynkError("NOT_FOUND", `No connected client with session ${sessionId}.`, { suggestions: ["rynk clients"] });
  const s = await client.disconnect(projectId, sessionId, Boolean(o.block));
  if (o.json) return json(s), 0;
  process.stdout.write(`${sym.ok} Disconnected ${s.clientAddress}${o.block ? c.dim(" — this address is blocked until hosting stops") : ""}\n`);
  return 0;
}

export async function unblock(address: string, o: { project?: string; json?: boolean }): Promise<number> {
  const client = await requireDaemon();
  const p = await projectRef(client, o.project);
  const r = await client.unblock(p.id, address);
  if (o.json) return json(r), 0;
  process.stdout.write(r.ok ? `${sym.ok} ${address} can connect again\n` : `${address} wasn't blocked\n`);
  return 0;
}

/** `rynk limit <n>`: change the maximum number of active users (0 = unlimited). */
export async function limit(value: string, ref: string | undefined, o: { json?: boolean }): Promise<number> {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new RynkError("CONFIG_INVALID", `"${value}" isn't a valid limit.`, { suggestions: ["rynk limit 20", "rynk limit 0   # unlimited"] });
  const client = await requireDaemon();
  const p = await projectRef(client, ref);
  const access = await client.setAccess(p.id, { maxUsers: n });
  if (o.json) return json(access), 0;
  const v = await client.clients(p.id).catch(() => null);
  process.stdout.write(`${sym.ok} ${c.bold(p.name)}: up to ${n || "unlimited"} active users${v ? c.dim(` (${v.active} connected now)`) : ""}\n`);
  if (v && n && v.active > n) process.stdout.write(c.dim("  People already connected stay connected; new visitors wait until someone leaves.\n"));
  return 0;
}

export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* no browser available */
  }
}
