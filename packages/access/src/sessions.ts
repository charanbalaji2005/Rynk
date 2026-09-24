import crypto from "node:crypto";
import type { AccessConfig, ClientSession, InviteLink } from "@rynk/core";

export interface SessionEvent {
  kind: "opened" | "idle" | "active" | "closed";
  session: ClientSession;
}

interface Internal extends ClientSession {
  fingerprint: string;
  cookieConfirmed: boolean;
  sockets: Set<{ destroy(): void }>;
  ended: boolean;
}

/** Default: how long an idle session is remembered before it is forgotten entirely. */
const FORGET_AFTER_MS = 10 * 60_000;
/** Requests without our cookie from the same address+agent within this window join one session. */
const FINGERPRINT_WINDOW_MS = 15_000;

const normalizeAddress = (a: string | undefined) => (a ?? "unknown").replace(/^::ffff:/, "");

/**
 * The session table behind the access gateway.
 *
 * Definition of an *active user* (documented in docs/access-control.md):
 * a session that made a request within `idleTimeoutMs`, or that currently
 * holds an open connection (WebSocket, SSE or other streaming response).
 * Many requests from one browser tab share one session via an HttpOnly cookie,
 * so page assets never inflate the count.
 */
export class SessionTable {
  private sessions = new Map<string, Internal>();
  private blocked = new Set<string>();
  private invites = new Map<string, InviteLink & { tokenHash: string }>();
  private listeners: Array<(e: SessionEvent) => void> = [];

  constructor(public policy: AccessConfig) {}

  onEvent(fn: (e: SessionEvent) => void) {
    this.listeners.push(fn);
  }

  private emit(kind: SessionEvent["kind"], s: Internal) {
    const session = this.public(s);
    for (const fn of this.listeners) fn({ kind, session });
  }

  private public(s: Internal): ClientSession {
    const { fingerprint: _f, cookieConfirmed: _c, sockets: _s, ended: _e, ...rest } = s;
    return { ...rest, openConnections: s.sockets.size + s.openConnections };
  }

  static fingerprint(address: string, userAgent: string | undefined) {
    return crypto.createHash("sha256").update(`${normalizeAddress(address)}|${userAgent ?? ""}`).digest("hex").slice(0, 32);
  }

  // ── lookups ──────────────────────────────────────────────
  get(id: string | undefined) {
    return id ? this.sessions.get(id) : undefined;
  }

  byFingerprint(fp: string): Internal | undefined {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.fingerprint !== fp || s.ended || s.status === "closed") continue;
      // Clients that never send cookies back keep using their fingerprint session;
      // cookie-capable browsers only share one briefly (parallel first requests).
      if (!s.cookieConfirmed || now - s.connectedAt < FINGERPRINT_WINDOW_MS) return s;
    }
    return undefined;
  }

  isActive(s: Internal, now = Date.now()) {
    return !s.ended && (s.sockets.size > 0 || s.openConnections > 0 || now - s.lastSeenAt < this.policy.idleTimeoutMs);
  }

  activeCount(now = Date.now()) {
    let n = 0;
    for (const s of this.sessions.values()) if (this.isActive(s, now)) n++;
    return n;
  }

  list(): ClientSession[] {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((s) => !s.ended)
      .map((s) => this.public({ ...s, status: this.isActive(s, now) ? "active" : "idle" }))
      .sort((a, b) => a.connectedAt - b.connectedAt);
  }

  // ── admission ────────────────────────────────────────────
  isBlocked(address: string) {
    return this.blocked.has(normalizeAddress(address));
  }

  /** Whether a session that isn't currently active may become active. */
  hasCapacity() {
    return this.policy.maxUsers <= 0 || this.activeCount() < this.policy.maxUsers;
  }

  create(address: string, userAgent: string | undefined, invited: boolean): Internal {
    const now = Date.now();
    const s: Internal = {
      sessionId: "cs_" + crypto.randomBytes(12).toString("base64url"),
      clientAddress: normalizeAddress(address),
      ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}),
      connectedAt: now,
      lastSeenAt: now,
      status: "active",
      requests: 0,
      openConnections: 0,
      identifiedBy: "fingerprint",
      invited,
      fingerprint: SessionTable.fingerprint(address, userAgent),
      cookieConfirmed: false,
      sockets: new Set(),
      ended: false,
    };
    this.sessions.set(s.sessionId, s);
    this.emit("opened", s);
    return s;
  }

  touch(s: Internal, viaCookie: boolean) {
    const wasActive = this.isActive(s);
    s.lastSeenAt = Date.now();
    s.requests++;
    if (viaCookie && !s.cookieConfirmed) {
      s.cookieConfirmed = true;
      s.identifiedBy = "cookie";
    }
    if (!wasActive || s.status !== "active") {
      s.status = "active";
      if (s.requests > 1) this.emit("active", s);
    }
  }

  beginStream(s: Internal) {
    s.openConnections++;
  }
  endStream(s: Internal) {
    s.openConnections = Math.max(0, s.openConnections - 1);
    s.lastSeenAt = Date.now();
  }
  attachSocket(s: Internal, sock: { destroy(): void }) {
    s.sockets.add(sock);
  }
  socketCount(s: Internal) {
    return s.sockets.size;
  }
  detachSocket(s: Internal, sock: { destroy(): void }) {
    s.sockets.delete(sock);
    s.lastSeenAt = Date.now();
  }

  /** End a session now: its open connections are closed and its cookie stops working. */
  end(sessionId: string, opts: { block?: boolean } = {}): ClientSession | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    s.ended = true;
    s.status = "closed";
    for (const sock of s.sockets) sock.destroy();
    s.sockets.clear();
    if (opts.block) this.blocked.add(s.clientAddress);
    this.emit("closed", s);
    // Keep a tombstone briefly so the ended client sees "session ended", not a new session.
    setTimeout(() => this.sessions.delete(sessionId), 60_000).unref();
    return this.public(s);
  }

  isEnded(id: string | undefined) {
    return Boolean(id && this.sessions.get(id)?.ended);
  }

  unblock(address: string) {
    return this.blocked.delete(normalizeAddress(address));
  }

  blockedAddresses() {
    return [...this.blocked];
  }

  /** Periodic maintenance: flip active→idle and forget long-idle sessions. */
  sweep(now = Date.now()) {
    for (const s of this.sessions.values()) {
      if (s.ended) continue;
      const active = this.isActive(s, now);
      if (!active && s.status === "active") {
        s.status = "idle";
        this.emit("idle", s);
      }
      if (!active && now - s.lastSeenAt > (this.policy.clientRetentionMs ?? FORGET_AFTER_MS)) {
        s.status = "closed";
        this.sessions.delete(s.sessionId);
        this.emit("closed", s);
      }
    }
  }

  clear() {
    for (const s of this.sessions.values()) for (const sock of s.sockets) sock.destroy();
    this.sessions.clear();
  }

  // ── invites ──────────────────────────────────────────────
  createInvite(ttlMs: number, maxUses: number): { invite: InviteLink; token: string } {
    const token = crypto.randomBytes(18).toString("base64url");
    const invite = {
      id: "inv_" + crypto.randomBytes(6).toString("hex"),
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      maxUses,
      uses: 0,
      revoked: false,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    };
    this.invites.set(invite.id, invite);
    const { tokenHash: _t, ...pub } = invite;
    return { invite: pub, token };
  }

  /** Validate and consume one use of an invite token. */
  redeem(token: string): boolean {
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    for (const inv of this.invites.values()) {
      if (!crypto.timingSafeEqual(Buffer.from(inv.tokenHash), Buffer.from(hash))) continue;
      if (inv.revoked || inv.expiresAt < Date.now() || inv.uses >= inv.maxUses) return false;
      inv.uses++;
      return true;
    }
    return false;
  }

  revokeInvite(id: string) {
    const inv = this.invites.get(id);
    if (inv) inv.revoked = true;
    return Boolean(inv);
  }

  listInvites(): InviteLink[] {
    return [...this.invites.values()].map(({ tokenHash: _t, ...pub }) => pub);
  }
}
