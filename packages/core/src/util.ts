import crypto from "node:crypto";
import path from "node:path";

export function newId(prefix = ""): string {
  return prefix + crypto.randomBytes(8).toString("hex");
}

/** Stable project id derived from its absolute root path. */
export function projectIdFor(root: string): string {
  return "prj_" + crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
}

/** URL/DNS safe slug for routes and container names. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "app";
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function parseDuration(v: string | number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(v.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!);
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Substitute {port} / {host} placeholders. */
export function interpolate(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Package manager / build tool implied by a project's commands. */
export function packageManagerOf(p: { install?: Array<{ file: string }>; start?: { file: string; args?: string[] } }): string | undefined {
  const files = [...(p.install ?? []).map((c) => c.file), p.start?.file ?? ""];
  const map: Record<string, string> = { npm: "npm", pnpm: "pnpm", yarn: "yarn", bun: "bun", uv: "uv", poetry: "poetry", pipenv: "pipenv", cargo: "cargo", go: "go", mvn: "maven", mvnw: "maven", gradle: "gradle", gradlew: "gradle", composer: "composer", bundle: "bundler", dotnet: "dotnet", deno: "deno", php: "composer" };
  for (const f of files) {
    const bin = f.split(/[\\/]/).pop()?.replace(/\.(cmd|exe|bat)$/i, "") ?? "";
    if (map[bin]) return map[bin];
    if (/python/.test(bin) || bin === "pip") return "pip";
  }
  return undefined;
}

/** Derive what Rynk can control for a project from its binding and health settings. */
export function runtimeCapabilities(p: { runtime: string; binding: { env?: Record<string, string>; args?: string[]; portControllable: boolean }; health: { type: string } }) {
  const args = (p.binding.args ?? []).join(" ");
  const env = Object.values(p.binding.env ?? {}).join(" ");
  return {
    supportsHostFlag: args.includes("{host}"),
    supportsPortFlag: args.includes("{port}"),
    supportsHostEnv: env.includes("{host}"),
    supportsPortEnv: env.includes("{port}"),
    supportsHealthCheck: ["http", "tcp", "command"].includes(p.health.type),
    // Every runtime stops gracefully first (SIGTERM / CTRL_BREAK / docker stop / compose down), then forcefully.
    supportsGracefulShutdown: true,
  };
}
