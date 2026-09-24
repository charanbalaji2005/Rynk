import chalk from "chalk";
import { RynkError, formatBytes, formatDuration, type DeploymentState, type DeploymentURLs, type HealthStatus } from "@rynk/core";

export const isTTY = Boolean(process.stdout.isTTY) && !process.env.CI;

export const c = {
  brand: chalk.hex("#7C8CFF").bold,
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
  dim: chalk.dim,
  bold: chalk.bold,
  url: chalk.cyan.underline,
  label: chalk.gray,
};

export const sym = {
  ok: chalk.green("✓"),
  fail: chalk.red("✗"),
  warn: chalk.yellow("⚠"),
  info: chalk.blue("ℹ"),
  dot: "●",
};

const STATE_COLOR: Partial<Record<DeploymentState, (s: string) => string>> = {
  LIVE: chalk.green,
  FAILED: chalk.red,
  STOPPED: chalk.gray,
  STOPPING: chalk.gray,
  RESTARTING: chalk.yellow,
};

export function stateBadge(state: DeploymentState | string | undefined): string {
  if (!state) return chalk.gray("● never run");
  const color = STATE_COLOR[state as DeploymentState] ?? chalk.blue;
  return color(`● ${state}`);
}

export function healthText(h: HealthStatus | string | undefined): string {
  if (!h) return "";
  if (h === "HEALTHY") return chalk.green(h);
  if (h === "DEGRADED" || h === "STARTING") return chalk.yellow(h);
  if (h === "UNHEALTHY" || h === "CRASHED") return chalk.red(h);
  return chalk.gray(h);
}

 
const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => [...s.replace(ANSI, "")].length;

/** Rounded box that respects the terminal width and ANSI colours. */
export function box(lines: string[], opts: { title?: string; width?: number } = {}): string {
  const termWidth = Math.max(40, Math.min(process.stdout.columns || 80, 100));
  const inner = Math.min(termWidth - 4, Math.max(opts.width ?? 0, ...lines.map(visible), visible(opts.title ?? "") + 2));
  const fit = (s: string) => {
    if (visible(s) <= inner) return s;
    const plain = [...s.replace(ANSI, "")];
    return plain.slice(0, inner - 1).join("") + "…";
  };
  const pad = (raw: string) => {
    const s = fit(raw);
    return s + " ".repeat(Math.max(0, inner - visible(s)));
  };
  const top = opts.title
    ? `╭─ ${opts.title} ${"─".repeat(Math.max(0, inner - visible(opts.title) - 1))}╮`
    : `╭${"─".repeat(inner + 2)}╮`;
  const body = lines.map((l) => `│ ${pad(l)} │`);
  return [top, ...body, `╰${"─".repeat(inner + 2)}╯`].join("\n");
}

export function urlLines(urls: DeploymentURLs | null | undefined, opts: { proxy?: boolean } = {}): string[] {
  if (!urls) return [];
  const out: string[] = [];
  if (urls.network) out.push(`${c.label("Share:  ")} ${c.url(urls.network)}`);
  out.push(`${c.label("Local:  ")} ${c.url(urls.local)}`);
  for (const extra of urls.networkAll?.filter((u) => u !== urls.network) ?? []) out.push(`${c.label("Also:   ")} ${c.url(extra)}`);
  if (opts.proxy && urls.proxy) out.push(`${c.label("Name:   ")} ${c.url(urls.proxy)}`);
  if (urls.public) out.push(`${c.label("Public: ")} ${c.url(urls.public)}  ${c.warn("(internet-visible)")}`);
  return out;
}

/** The link to hand to other people: public tunnel, else LAN, else local. */
export function shareUrl(urls: DeploymentURLs | null | undefined): string | undefined {
  return urls?.public ?? urls?.network ?? urls?.local;
}

export function usersText(access: { maxUsers: number; active: number; mode?: string; managed?: boolean } | null | undefined): string {
  if (!access) return c.dim("—");
  if (access.managed === false) return c.dim("not tracked");
  return `${access.active} / ${access.maxUsers || "∞"}${access.mode === "protected" ? c.dim("  invite only") : ""}`;
}

const RUNTIME_LABELS: Record<string, string> = { node: "Node.js", python: "Python", go: "Go", rust: "Rust", java: "Java", php: "PHP", ruby: "Ruby", dotnet: ".NET", deno: "Deno", static: "Static", docker: "Docker", custom: "Custom" };
export function runtimeLabel(language: string | null | undefined, runtime?: string | null): string {
  if (runtime === "docker" || runtime === "compose") return "Docker";
  if (runtime === "static") return "Static";
  return RUNTIME_LABELS[language ?? ""] ?? language ?? runtime ?? "unknown";
}

export function metricsText(m: { cpu: number; memoryBytes: number; uptimeMs: number } | null | undefined): string {
  if (!m) return c.dim("—");
  return `${m.cpu.toFixed(1)}% cpu  ${formatBytes(m.memoryBytes)}  up ${formatDuration(m.uptimeMs)}`;
}

/** Print an error the friendly way; raw details only with --verbose. */
export function printError(e: unknown, opts: { verbose?: boolean; json?: boolean } = {}): void {
  const err = RynkError.from(e);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.toJSON() }, null, 2) + "\n");
    return;
  }
  const out: string[] = ["", `${sym.fail} ${c.bold(err.message)}`];
  if (err.causes.length) {
    out.push("", c.dim("Possible causes:"));
    for (const cause of err.causes) out.push(`  • ${cause}`);
  }
  if (err.suggestions.length) {
    out.push("", c.dim("Try:"));
    for (const s of err.suggestions) out.push(`  ${c.bold(s)}`);
  }
  if (opts.verbose && err.cause) out.push("", c.dim(String((err.cause as Error)?.stack ?? err.cause)));
  process.stderr.write(out.join("\n") + "\n\n");
}

export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header.map((h) => c.dim(h)), ...rows] : rows;
  const widths = all[0]?.map((_, i) => Math.max(...all.map((r) => visible(r[i] ?? "")))) ?? [];
  return all.map((r) => r.map((cell, i) => cell + " ".repeat(Math.max(0, (widths[i] ?? 0) - visible(cell)))).join("   ").trimEnd()).join("\n");
}

/** Compact relative time: "8s ago", "4m ago", "2h ago". */
export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 172_800 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86_400)}d ago`;
}

/** Copy text to the system clipboard. Returns false when no clipboard tool exists (e.g. headless Linux). */
export async function copyToClipboard(text: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin" ? [["pbcopy", []]]
    : process.platform === "win32" ? [["clip", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [cmd, args] of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
      child.stdin.end(text);
    });
    if (ok) return true;
  }
  return false;
}
