import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedHost, isAllowedOrigin, isSensitivePath, OneTimeTokens, RateLimiter, Redactor, safeEqual, sanitizeEnv, validateCommand } from "../src/index.js";

describe("redaction", () => {
  const r = new Redactor();
  it("removes common credential shapes", () => {
    const line = "key sk_live_abcdefghijklmnop1234 gh ghp_abcdefghijklmnopqrstuvwxyz0123456789 aws AKIAABCDEFGHIJKLMNOP";
    const out = r.redact(line);
    expect(out).not.toMatch(/sk_live_|ghp_|AKIA/);
  });
  it("redacts KEY=value pairs and URL passwords", () => {
    expect(r.redact("DB_PASSWORD=hunter22 ok")).toBe("DB_PASSWORD=[REDACTED] ok");
    expect(r.redact("postgres://user:s3cret@db:5432/app")).toBe("postgres://user:[REDACTED]@db:5432/app");
  });
  it("redacts literal env secrets", () => {
    const x = new Redactor();
    x.addFromEnv({ STRIPE_SECRET: "super-secret-value", HOME: "/home/me" });
    expect(x.redact("using super-secret-value in /home/me")).toBe("using [REDACTED] in /home/me");
  });
});

describe("sensitive paths", () => {
  it.each(["/.env", "/.env.local", "/app/.git/config", "/id_rsa", "/cert.pem", "/data/app.sqlite", "/secrets.yaml"])("blocks %s", (p) => {
    expect(isSensitivePath(p)).toBe(true);
  });
  it.each(["/", "/index.html", "/assets/app.js", "/environment.html"])("allows %s", (p) => {
    expect(isSensitivePath(p)).toBe(false);
  });
});

describe("host/origin checks (DNS rebinding + CSRF)", () => {
  it("accepts loopback hosts only", () => {
    expect(isAllowedHost("127.0.0.1:9876")).toBe(true);
    expect(isAllowedHost("localhost:9876")).toBe(true);
    expect(isAllowedHost("[::1]:9876")).toBe(true);
    expect(isAllowedHost("evil.example:9876")).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });
  it("requires same-origin browsers", () => {
    expect(isAllowedOrigin(undefined, "127.0.0.1:9876")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:9876", "127.0.0.1:9876")).toBe(true);
    expect(isAllowedOrigin("http://evil.example", "127.0.0.1:9876")).toBe(false);
  });
});

describe("tokens", () => {
  it("compares in constant time and handles length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual(undefined, "x")).toBe(false);
  });
  it("one-time tokens work exactly once", () => {
    const t = new OneTimeTokens(1000);
    const tok = t.issue();
    expect(t.consume(tok)).toBe(true);
    expect(t.consume(tok)).toBe(false);
  });
});

describe("environment sanitising", () => {
  it("never passes the daemon token to apps", () => {
    const env = sanitizeEnv({ PATH: "/bin", RYNK_DAEMON_TOKEN: "x", RYNK_INTERNAL_DAEMON_TOKEN: "y" }, { PORT: "3000", "BAD KEY": "z" });
    expect(env).toEqual({ PATH: "/bin", PORT: "3000" });
  });
});

describe("command validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rynk-cmd-"));
  it("allows PATH commands and project-relative executables", () => {
    expect(() => validateCommand({ file: "npm", args: [], display: "npm" }, root)).not.toThrow();
    expect(() => validateCommand({ file: "./bin/server", args: [], display: "" }, root)).not.toThrow();
  });
  it("rejects executables escaping the project", () => {
    expect(() => validateCommand({ file: "../../bin/sh", args: [], display: "" }, root)).toThrow(/escapes/);
    expect(() => validateCommand({ file: "/usr/bin/env", args: [], display: "" }, root)).toThrow(/outside/);
  });
  it("allows virtualenv-style symlinked interpreters", () => {
    fs.mkdirSync(path.join(root, ".venv/bin"), { recursive: true });
    try {
      fs.symlinkSync(process.execPath, path.join(root, ".venv/bin/python"));
    } catch (e: any) {
      if (process.platform === "win32" && (e?.code === "EPERM" || e?.code === "EACCES")) {
        return; // Symlinks require elevated privileges or Developer Mode on Windows
      }
      throw e;
    }
    expect(() => validateCommand({ file: ".venv/bin/python", args: [], display: "" }, root)).not.toThrow();
  });
  it("only lets users run shell commands", () => {
    const sh = { file: "sh", args: ["-c", "a && b"], display: "a && b", shell: true };
    expect(() => validateCommand(sh, root, { origin: "detector" })).toThrow();
    expect(() => validateCommand(sh, root, { origin: "user" })).not.toThrow();
  });
});

describe("rate limiter", () => {
  it("throttles bursts", () => {
    const rl = new RateLimiter(3, 0);
    expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, true, false]);
    expect(rl.take("b")).toBe(true);
  });
});
