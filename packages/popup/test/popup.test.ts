import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findTkPython, hasDisplay, popupProviders, qrMatrix, runtimeFromChoice, type FromPopup, type PopupInit } from "../src/index.js";

const init: PopupInit = {
  type: "init",
  project: { name: "demo", root: "/tmp/demo", framework: "Vite", runtimeLabel: "Node.js", packageManager: "pnpm", command: "pnpm run dev" },
  options: { runtimes: ["Auto", "Docker", "Static", "Custom command"], ports: [3000, 5173] },
  network: { interfaces: [{ name: "wlan0", label: "Wi-Fi", address: "192.168.1.42", kind: "wifi" }], selected: "192.168.1.42" },
  defaults: { name: "demo", command: "pnpm run dev", runtime: "Auto", port: "Auto", host: "Auto", exposure: "lan", maxUsers: 5, protected: false, autoRestart: true, healthCheck: true, advertise: true },
  sharePort: 5173,
};

describe("popup protocol helpers", () => {
  it("maps runtime choices", () => {
    expect(runtimeFromChoice("Auto")).toBe("auto");
    expect(runtimeFromChoice("Docker")).toBe("docker");
    expect(runtimeFromChoice("Custom command")).toBe("custom");
  });
  it("builds a square QR matrix", () => {
    const m = qrMatrix("http://192.168.1.42:5173");
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.every((row) => row.length === m.length && /^[01]+$/.test(row))).toBe(true);
    expect(m[0]!.startsWith("1111111")).toBe(true); // finder pattern
  });
  it("honours RYNK_POPUP", () => {
    expect(popupProviders({ RYNK_POPUP: "off" })).toEqual([]);
    expect(popupProviders({ RYNK_POPUP: "terminal" })).toEqual(["terminal"]);
    expect(popupProviders({ RYNK_POPUP: "auto" }).at(-1)).toBe("terminal"); // always a fallback
  });
  it("knows when there's no desktop session", () => {
    if (process.platform === "linux") expect(hasDisplay({})).toBe(false);
  });
});

import { spawnSync } from "node:child_process";

/** Only run the window test when a Tk window can really open (a stale $DISPLAY would hang it). */
function canOpenTkWindow(): boolean {
  if (process.platform === "win32" || !process.env.DISPLAY) return false;
  const py = findTkPython();
  if (!py) return false;
  const r = spawnSync(py[0]!, [...py.slice(1), "-c", "import tkinter; tkinter.Tk().destroy()"], { timeout: 5000 });
  return r.status === 0;
}
const canRunTk = canOpenTkWindow();

describe.skipIf(!canRunTk)("Tk popup (native window)", () => {
  it("speaks the protocol: ready → init → start with the user's settings → live → closed", async () => {
    const script = fileURLToPath(new URL("../assets/rynk_popup.py", import.meta.url));
    const py = findTkPython()!;
    const child = spawn(py[0]!, [...py.slice(1), script], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, RYNK_POPUP_AUTOSTART: "300" } });
    const got: FromPopup[] = [];
    const rl = readline.createInterface({ input: child.stdout! });
    const next = (type: string) => new Promise<FromPopup>((resolve) => {
      const found = got.find((m) => m.type === type);
      if (found) return resolve(found);
      const on = (line: string) => {
        const m = JSON.parse(line) as FromPopup;
        got.push(m);
        if (m.type === type) {
          rl.off("line", on);
          resolve(m);
        }
      };
      rl.on("line", on);
    });
    await next("ready");
    child.stdin!.write(JSON.stringify(init) + "\n");
    const start = (await next("start")) as Extract<FromPopup, { type: "start" }>;
    expect(start.settings).toMatchObject({ name: "demo", command: "pnpm run dev", network: "192.168.1.42", exposure: "lan", maxUsers: 5, autoRestart: true });
    child.stdin!.write(JSON.stringify({ type: "live", name: "demo", urls: { network: "http://192.168.1.42:5173" }, port: 5173, pid: 1, health: "HEALTHY", uptimeMs: 0, access: { maxUsers: 5, mode: "open" }, warnings: [] }) + "\n");
    child.stdin!.write(JSON.stringify({ type: "status", health: "HEALTHY", pid: 1, users: { active: 1, limit: 5 }, clients: [{ sessionId: "cs_1", clientAddress: "192.168.1.51", status: "active", connectedAt: Date.now() }] }) + "\n");
    child.stdin!.write(JSON.stringify({ type: "close" }) + "\n");
    await new Promise((r) => child.once("exit", r));
    expect(child.exitCode).toBe(0);
  }, 20_000);
});
