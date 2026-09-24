import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execa, type ResultPromise } from "execa";
import pidusage from "pidusage";
import { RynkError, type CommandSpec } from "@rynk/core";

export const isWindows = process.platform === "win32";

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

/** A supervised OS process whose whole tree can be terminated reliably. */
export class ManagedProcess {
  readonly pid: number | undefined;
  readonly startedAt = Date.now();
  private exitInfo: ExitInfo | null = null;
  readonly exited: Promise<ExitInfo>;

  constructor(private readonly child: ResultPromise, onLine?: SpawnOptions["onLine"]) {
    this.pid = child.pid;
    for (const stream of ["stdout", "stderr"] as const) {
      const s = child[stream];
      if (!s) continue;
      const rl = readline.createInterface({ input: s, crlfDelay: Infinity });
      rl.on("line", (l) => onLine?.(l, stream));
    }
    this.exited = child.then(
      (r) => (this.exitInfo = { code: r.exitCode ?? null, signal: r.signal ?? null }),
      (e: { exitCode?: number; signal?: string }) => (this.exitInfo = { code: e.exitCode ?? null, signal: e.signal ?? null }),
    );
  }

  get alive(): boolean {
    return this.exitInfo === null;
  }

  get exit(): ExitInfo | null {
    return this.exitInfo;
  }

  /** SIGTERM the whole tree, escalate to SIGKILL after the grace period. */
  async kill(graceMs = 5000): Promise<ExitInfo> {
    if (!this.alive || this.pid === undefined) return this.exitInfo ?? { code: null, signal: null };
    killTree(this.pid, "SIGTERM");
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs).unref());
    if ((await Promise.race([this.exited, timeout])) === "timeout") {
      killTree(this.pid, "SIGKILL");
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2000).unref())]);
    }
    return this.exitInfo ?? { code: null, signal: "SIGKILL" };
  }
}

/** Kill a process and all of its descendants. */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (isWindows) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { windowsHide: true, stdio: "ignore" });
      if (signal !== "SIGKILL") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      // Children are spawned detached as group leaders, so -pid targets the whole group.
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

const live = new Set<ManagedProcess>();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Last-resort cleanup so a crashing Rynk never leaves orphaned dev servers.
  process.on("exit", () => {
    for (const p of live) if (p.alive && p.pid) killTree(p.pid, "SIGKILL");
  });
}

export function spawnManaged(command: CommandSpec, opts: SpawnOptions): ManagedProcess {
  installExitHook();
  const common = {
    cwd: opts.cwd,
    env: opts.env,
    extendEnv: false,
    stdin: "ignore" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    buffer: false,
    reject: false,
    detached: !isWindows,
    cleanup: true,
    windowsHide: true,
  };
  let child: ResultPromise;
  try {
    child = command.shell ? execa(command.file, { ...common, shell: true }) : execa(command.file, command.args, common);
  } catch (e) {
    throw new RynkError("START_FAILED", `Could not run ${command.display}`, { cause: e });
  }
  const mp = new ManagedProcess(child, opts.onLine);
  live.add(mp);
  mp.exited.finally(() => live.delete(mp));
  return mp;
}

/** Run a command to completion (install/build steps), streaming its output. */
export async function runStep(command: CommandSpec, opts: SpawnOptions & { signal?: AbortSignal; timeoutMs?: number }): Promise<ExitInfo & { tail: string[] }> {
  const tail: string[] = [];
  const p = spawnManaged(command, {
    ...opts,
    onLine: (l, s) => {
      tail.push(l);
      if (tail.length > 40) tail.shift();
      opts.onLine?.(l, s);
    },
  });
  const onAbort = () => void p.kill(2000);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  if (opts.timeoutMs) timer = setTimeout(onAbort, opts.timeoutMs);
  const exit = await p.exited;
  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  return { ...exit, tail };
}

/** Resolve a command on PATH without executing it (cross-platform `which`). */
export function which(bin: string): string | null {
  const r = isWindows
    ? spawnSync("where", [bin], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-c", 'command -v "$1"', "sh", bin], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout.split(/\r?\n/)[0]?.trim() ?? null) : null;
}

/** Return a tool's version string, or null when it isn't installed. */
export async function toolVersion(bin: string, args = ["--version"]): Promise<string | null> {
  try {
    const r = await execa(bin, args, { reject: false, timeout: 8000, windowsHide: true, stdin: "ignore" });
    if (r.exitCode !== 0) return null;
    const out = `${r.stdout}\n${r.stderr}`.trim();
    return /(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1] ?? (out.split("\n")[0] || null);
  } catch {
    return null;
  }
}

export interface ProcessStats {
  cpu: number;
  memoryBytes: number;
}

export async function processStats(pid: number): Promise<ProcessStats | null> {
  try {
    const s = await pidusage(pid);
    return { cpu: Math.round(s.cpu * 10) / 10, memoryBytes: s.memory };
  } catch {
    if (process.platform === "win32") {
      try {
        const r = await execa(
          "powershell.exe",
          ["-NoProfile", "-Command", `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; "$([Math]::Round($p.CPU, 1))|$($p.WorkingSet64)"`],
          { reject: false, timeout: 5000, windowsHide: true },
        );
        const [cpuStr, memStr] = r.stdout.trim().split("|");
        const cpu = parseFloat(cpuStr || "0");
        const memoryBytes = parseInt(memStr || "0", 10);
        if (Number.isFinite(memoryBytes) && memoryBytes > 0) {
          return { cpu: Number.isFinite(cpu) ? cpu : 0, memoryBytes };
        }
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * True when `pid` is alive and was started at roughly `startedAt` — guards
 * against PID reuse before we touch a process recorded in a previous session.
 */
export async function isSameProcess(pid: number, startedAt: number, toleranceMs = 10_000): Promise<boolean> {
  try {
    const s = await pidusage(pid);
    return Math.abs(Date.now() - s.elapsed - startedAt) <= toleranceMs;
  } catch {
    if (process.platform === "win32") {
      try {
        const r = await execa(
          "powershell.exe",
          ["-NoProfile", "-Command", `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds()`],
          { reject: false, timeout: 5000, windowsHide: true },
        );
        const ts = Number(r.stdout.trim());
        if (Number.isFinite(ts) && ts > 0) {
          return Math.abs(ts - startedAt) <= toleranceMs;
        }
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Before touching a PID recorded in a previous session, prove it is still the
 * same process: alive, started at the recorded time, and — where the OS lets
 * us see it — running the recorded command in the recorded directory.
 */
export async function verifyProcess(pid: number, expect: { startedAt: number; command?: string | null; cwd?: string | null }): Promise<{ ok: boolean; reason?: string }> {
  if (!(await isSameProcess(pid, expect.startedAt))) return { ok: false, reason: "not running, or a different process now has this PID" };
  const info = await processInfo(pid);
  if (expect.command && info.command) {
    const bin = expect.command.trim().split(/\s+/)[0]!.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
    if (bin && !info.command.toLowerCase().includes(bin)) return { ok: false, reason: `runs "${info.command.slice(0, 80)}", not ${bin}` };
  }
  if (expect.cwd && info.cwd && path.resolve(info.cwd) !== path.resolve(expect.cwd)) return { ok: false, reason: `runs in ${info.cwd}, not ${expect.cwd}` };
  return { ok: true };
}

/** Command line and working directory of a process, when the OS exposes them. */
export async function processInfo(pid: number): Promise<{ command?: string; cwd?: string }> {
  try {
    if (process.platform === "linux") {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      let cwd: string | undefined;
      try {
        cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        /* other user's process */
      }
      return { ...(command ? { command } : {}), ...(cwd ? { cwd } : {}) };
    }
    if (process.platform === "win32") {
      const r = await execa("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { reject: false, timeout: 5000, windowsHide: true });
      return r.stdout.trim() ? { command: r.stdout.trim() } : {};
    }
    const r = await execa("ps", ["-p", String(Number(pid)), "-o", "command="], { reject: false, timeout: 3000 });
    return r.stdout.trim() ? { command: r.stdout.trim() } : {};
  } catch {
    return {};
  }
}

export function clearStats(pid: number): void {
  try {
    pidusage.clear();
  } catch {
    void pid;
  }
}
