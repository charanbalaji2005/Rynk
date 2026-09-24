import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { paths, RynkError, sleep, VERSION } from "@rynk/core";
import { readDaemonState, RynkClient } from "@rynk/sdk";

const require = createRequire(import.meta.url);

function daemonEntry(): string {
  try {
    return require.resolve("@rynk/daemon/main");
  } catch {
    throw new RynkError("DAEMON_UNREACHABLE", "Rynk's daemon files are missing from this installation.", {
      suggestions: ["npm install -g rynk", "pnpm build (when running from source)"],
    });
  }
}

/** Returns a client for a running, healthy daemon — or null. */
export async function connect(): Promise<RynkClient | null> {
  const state = readDaemonState();
  if (!state) return null;
  const client = new RynkClient(state);
  try {
    await client.health();
    return client;
  } catch {
    return null;
  }
}

/**
 * Make sure a daemon is running and return a client. Spawns a detached
 * daemon when needed so deployments outlive this CLI process. A daemon from
 * a different Rynk version is replaced when it has nothing running.
 */
export async function ensureDaemon(opts: { quiet?: boolean } = {}): Promise<RynkClient> {
  const existing = await connect();
  if (existing) {
    if (existing.daemon.version === VERSION) return existing;
    const info = (await existing.info().catch(() => ({}))) as { activeDeployments?: number };
    if (!info.activeDeployments) {
      await existing.shutdown().catch(() => undefined);
      await waitForExit(existing.daemon.pid, 8000);
    } else {
      if (!opts.quiet) process.stderr.write(`Note: daemon is v${existing.daemon.version}, CLI is v${VERSION}. Run "rynk daemon restart" when convenient.\n`);
      return existing;
    }
  }
  return spawnDaemon();
}

export async function spawnDaemon(): Promise<RynkClient> {
  fs.mkdirSync(paths.logs(), { recursive: true });
  const before = readDaemonState();
  const out = fs.openSync(paths.daemonLog() + ".stdio", "a");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", daemonEntry()], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: { ...process.env, RYNK_DAEMON_CHILD: "1" },
  });
  child.unref();

  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await sleep(150);
      const state = readDaemonState();
      if (state && (state.pid === child.pid || state.startedAt !== before?.startedAt)) {
        const client = new RynkClient(state);
        if (await client.health().then(() => true, () => false)) return client;
      }
      if (child.exitCode !== null) break;
    }
  } finally {
    try {
      fs.closeSync(out);
    } catch {
      /* ignore */
    }
  }
  let tail = "";
  try {
    tail = fs.readFileSync(paths.daemonLog() + ".stdio", "utf8").trim().split("\n").slice(-5).join("\n");
  } catch {
    /* no log */
  }
  throw new RynkError("DAEMON_UNREACHABLE", "The Rynk daemon did not start.", {
    causes: tail ? tail.split("\n") : ["Port 9876 may be in use by another program (set RYNK_DAEMON_PORT)."],
    suggestions: ["rynk doctor", `Check ${paths.daemonLog()}`],
  });
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

export async function stopDaemon(): Promise<boolean> {
  const client = await connect();
  if (!client) return false;
  await client.shutdown().catch(() => undefined);
  if (!(await waitForExit(client.daemon.pid, 20_000))) {
    try {
      process.kill(client.daemon.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return true;
}
