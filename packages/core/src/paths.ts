import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Return the canonical, real path of a project root directory.
 * Resolves symlinks (e.g. macOS /var -> /private/var), normalizes
 * Windows drive letters and casing, and falls back to path.resolve()
 * if the path does not exist on disk yet.
 */
export function canonicalPath(dir: string): string {
  try {
    return fs.realpathSync.native(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Platform-correct application data locations. Never hard-code user dirs.
 *   Linux:   $XDG_DATA_HOME/rynk or ~/.local/share/rynk
 *   macOS:   ~/Library/Application Support/Rynk
 *   Windows: %LOCALAPPDATA%\Rynk
 * RYNK_HOME / RYNK_DATA_DIR override everything.
 */
export function rynkHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RYNK_HOME) return path.resolve(env.RYNK_HOME);
  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Rynk");
    case "darwin":
      return path.join(home, "Library", "Application Support", "Rynk");
    default:
      return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "rynk");
  }
}

export function rynkDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RYNK_DATA_DIR ? path.resolve(env.RYNK_DATA_DIR) : path.join(rynkHome(env), "data");
}

export const paths = {
  home: () => rynkHome(),
  data: () => rynkDataDir(),
  database: () => path.join(rynkDataDir(), "rynk.db"),
  daemonState: () => path.join(rynkHome(), "daemon.json"),
  daemonLog: () => path.join(rynkHome(), "logs", "daemon.log"),
  logs: () => path.join(rynkHome(), "logs"),
  plugins: () => path.join(rynkHome(), "plugins"),
};

export const DEFAULTS = {
  daemonHost: "127.0.0.1",
  daemonPort: 9876,
  proxyPort: 7777,
  portRangeStart: 3000,
  portRangeEnd: 9999,
} as const;
