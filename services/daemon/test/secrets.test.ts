import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SecretBox } from "../src/secrets.js";

describe("SecretBox", () => {
  it("round-trips env and never stores plaintext", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rynk-sec-"));
    const box = new SecretBox(home);
    const sealed = box.sealEnv({ root: "/x", env: { STRIPE_SECRET: "sk_live_abcdefghijklmnop" } });
    expect(JSON.stringify(sealed)).not.toContain("sk_live");
    expect(box.openEnv(sealed).env).toEqual({ STRIPE_SECRET: "sk_live_abcdefghijklmnop" });
    expect(new SecretBox(home).openEnv(sealed).env).toEqual({ STRIPE_SECRET: "sk_live_abcdefghijklmnop" }); // same key file
    if (process.platform !== "win32") expect(fs.statSync(path.join(home, "secret.key")).mode & 0o077).toBe(0);
  });
  it("fails closed with a different key", () => {
    const a = new SecretBox(fs.mkdtempSync(path.join(os.tmpdir(), "rynk-a-")));
    const b = new SecretBox(fs.mkdtempSync(path.join(os.tmpdir(), "rynk-b-")));
    expect(b.openEnv(a.sealEnv({ env: { K: "v" } })).env).toEqual({});
  });
});
