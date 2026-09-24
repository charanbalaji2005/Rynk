import crypto from "node:crypto";

export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Constant-time comparison to avoid timing side channels on auth tokens. */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Short-lived single-use tokens (e.g. invite links). */
export class OneTimeTokens {
  private tokens = new Map<string, number>();
  constructor(private ttlMs = 60_000) {}
  issue(): string {
    const t = generateToken(24);
    this.tokens.set(t, Date.now() + this.ttlMs);
    return t;
  }
  consume(t: string | undefined): boolean {
    if (!t) return false;
    const exp = this.tokens.get(t);
    this.tokens.delete(t);
    for (const [k, v] of this.tokens) if (v < Date.now()) this.tokens.delete(k);
    return exp !== undefined && exp >= Date.now();
  }
}
