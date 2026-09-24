import { spawn } from "node:child_process";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { processInfo, verifyProcess } from "../src/index.js";

describe("verifyProcess (PID-reuse protection)", () => {
  it("accepts the right process and rejects wrong command, cwd or start time", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { cwd: os.tmpdir() });
    await new Promise((r) => setTimeout(r, 300));
    const startedAt = Date.now() - 300;
    try {
      const info = await processInfo(child.pid!);
      if (process.platform !== "win32") expect(info.command).toContain("setTimeout");
      expect((await verifyProcess(child.pid!, { startedAt, command: process.execPath })).ok).toBe(true);
      expect((await verifyProcess(child.pid!, { startedAt, command: "python3 server.py" })).ok).toBe(false);
      if (process.platform === "linux") expect((await verifyProcess(child.pid!, { startedAt, cwd: "/definitely/elsewhere" })).ok).toBe(false);
      expect((await verifyProcess(child.pid!, { startedAt: startedAt - 3_600_000 })).ok).toBe(false);
    } finally {
      child.kill();
    }
  });
});
