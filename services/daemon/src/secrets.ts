import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "rynk-sealed:v1:";

/**
 * Encrypts values Rynk must persist but shouldn't keep in plaintext — env
 * vars passed with `--env` or in rynk.yaml, which often hold API keys.
 * AES-256-GCM with a random key in RYNK_HOME/secret.key (owner-only). This
 * protects the database file if it's copied, backed up or shared on its own.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(home: string) {
    const file = path.join(home, "secret.key");
    let key: Buffer | undefined;
    try {
      key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    } catch {
      /* create */
    }
    if (!key || key.length !== 32) {
      key = crypto.randomBytes(32);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, key.toString("base64"), { mode: 0o600 });
    }
    this.key = key;
  }

  seal(value: unknown): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return PREFIX + [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
  }

  open<T>(sealed: string): T | undefined {
    if (!SecretBox.isSealed(sealed)) return undefined;
    try {
      const [iv, tag, ct] = sealed.slice(PREFIX.length).split(".").map((x) => Buffer.from(x, "base64"));
      const d = crypto.createDecipheriv("aes-256-gcm", this.key, iv!);
      d.setAuthTag(tag!);
      return JSON.parse(Buffer.concat([d.update(ct!), d.final()]).toString("utf8")) as T;
    } catch {
      return undefined; // wrong key (secret.key replaced) or tampered
    }
  }

  static isSealed(v: unknown): v is string {
    return typeof v === "string" && v.startsWith(PREFIX);
  }

  /** Replace an object's `env` with a sealed blob (no-op when empty). */
  sealEnv<T extends { env?: unknown }>(obj: T): T {
    if (!obj || !obj.env || typeof obj.env !== "object" || !Object.keys(obj.env as object).length) return obj;
    return { ...obj, env: this.seal(obj.env) };
  }

  openEnv<T extends { env?: unknown }>(obj: T): T {
    if (!obj || !SecretBox.isSealed(obj.env)) return obj;
    return { ...obj, env: this.open<Record<string, string>>(obj.env as string) ?? {} };
  }
}
