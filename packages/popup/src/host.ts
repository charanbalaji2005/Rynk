import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import type { FromPopup, PopupInit, ToPopup } from "./protocol.js";
import { runTerminalForm } from "./tui.js";

export type PopupProvider = "tk" | "winforms" | "terminal";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));

let pythonCache: string[] | null | undefined;

/** A Python with a working tkinter, or null. Cached per process. */
export function findTkPython(): string[] | null {
  if (pythonCache !== undefined) return pythonCache;
  const candidates = process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
  for (const c of candidates) {
    const r = spawnSync(c[0]!, [...c.slice(1), "-c", "import tkinter; print(tkinter.TkVersion)"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status === 0) return (pythonCache = c);
  }
  return (pythonCache = null);
}

/** Whether a desktop session is available to show a window in. */
export function hasDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform === "win32") return true;
  if (process.platform === "darwin") return !(env.SSH_CONNECTION || env.SSH_TTY) || Boolean(env.DISPLAY);
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Providers to try, best first, honouring RYNK_POPUP=tk|winforms|terminal|off. */
export function popupProviders(env: NodeJS.ProcessEnv = process.env): PopupProvider[] {
  const forced = (env.RYNK_POPUP ?? "auto").toLowerCase();
  if (forced === "off" || forced === "0" || forced === "false") return [];
  if (forced === "terminal" || forced === "tui") return ["terminal"];
  const out: PopupProvider[] = [];
  if (hasDisplay(env)) {
    if ((forced === "auto" || forced === "tk") && findTkPython()) out.push("tk");
    if ((forced === "auto" || forced === "winforms") && process.platform === "win32") out.push("winforms");
  }
  out.push("terminal");
  return out;
}

type Listener = (m: FromPopup) => void;

/** A running popup (or the terminal form standing in for one). */
export class PopupSession {
  private listeners: Listener[] = [];
  private closed = false;

  constructor(readonly provider: PopupProvider, private readonly child?: ChildProcess) {}

  on(fn: Listener) {
    this.listeners.push(fn);
  }

  /** @internal */
  emit(m: FromPopup) {
    for (const fn of this.listeners) fn(m);
  }

  get isWindow() {
    return this.provider !== "terminal";
  }

  get isOpen() {
    return !this.closed && (this.provider === "terminal" || (this.child !== undefined && this.child.exitCode === null));
  }

  send(m: ToPopup) {
    if (!this.child || this.closed || this.child.exitCode !== null) return;
    try {
      this.child.stdin?.write(JSON.stringify(m) + "\n");
    } catch {
      /* window already gone */
    }
  }

  close() {
    if (this.closed) return;
    this.send({ type: "close" });
    this.closed = true;
    setTimeout(() => this.child?.kill(), 1500).unref();
  }

  /** @internal */
  markClosed() {
    this.closed = true;
  }
}

function spawnWindow(provider: "tk" | "winforms"): ChildProcess | null {
  if (provider === "tk") {
    const py = findTkPython();
    const script = ASSETS + "rynk_popup.py";
    if (!py || !fs.existsSync(script)) return null;
    return spawn(py[0]!, [...py.slice(1), script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: false });
  }
  const script = ASSETS + "rynk_popup.ps1";
  if (!fs.existsSync(script)) return null;
  return spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

/**
 * Open the "Host this project" dialog. Tries a native window first and falls
 * back to the next provider if it fails to come up (missing toolkit, broken
 * display…), ending with the in-terminal form. Returns null when disabled.
 */
export async function openPopup(init: PopupInit, opts: { providers?: PopupProvider[]; readyTimeoutMs?: number; onDebug?: (m: string) => void } = {}): Promise<PopupSession | null> {
  for (const provider of opts.providers ?? popupProviders()) {
    if (provider === "terminal") {
      if (!process.stdin.isTTY) continue;
      const session = new PopupSession("terminal");
      setImmediate(async () => {
        const settings = await runTerminalForm(init);
        session.emit(settings ? { type: "start", settings } : { type: "cancel" });
      });
      return session;
    }
    const child = spawnWindow(provider);
    if (!child) continue;
    const session = new PopupSession(provider, child);
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)).slice(-2000));
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), opts.readyTimeoutMs ?? 10_000);
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        let m: FromPopup;
        try {
          m = JSON.parse(line) as FromPopup;
        } catch {
          return;
        }
        if (m.type === "ready") {
          clearTimeout(timer);
          resolve(true);
        } else session.emit(m);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        session.markClosed();
        resolve(false);
        session.emit({ type: "closed" });
      });
    });
    if (!ready) {
      opts.onDebug?.(`popup provider ${provider} failed: ${stderr.trim().split("\n").pop() ?? "no output"}`);
      child.kill();
      continue;
    }
    session.send(init);
    return session;
  }
  return null;
}
