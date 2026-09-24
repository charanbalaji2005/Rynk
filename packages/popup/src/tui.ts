import readline from "node:readline";
import type { PopupInit, PopupSettings } from "./protocol.js";

type Field =
  | { key: keyof PopupSettings; label: string; kind: "text" }
  | { key: keyof PopupSettings; label: string; kind: "choice"; options: Array<{ value: string; label: string }> }
  | { key: keyof PopupSettings; label: string; kind: "toggle" }
  | { key: keyof PopupSettings; label: string; kind: "number" };

const ESC = "\x1b[";
const dim = (s: string) => `${ESC}2m${s}${ESC}22m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}22m`;
const inverse = (s: string) => `${ESC}7m${s}${ESC}27m`;

/**
 * In-terminal fallback for the "Host this project" dialog, used over SSH,
 * on headless machines, or when no GUI toolkit is available. Keyboard only:
 * ↑/↓ move · ←/→ change · type to edit · space toggles · Enter starts · Esc cancels.
 */
export function runTerminalForm(init: PopupInit, io: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {}): Promise<PopupSettings | null> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const d = init.defaults;
  const values: PopupSettings = {
    name: d.name, command: d.command, runtime: d.runtime, port: d.port === "Auto" ? null : d.port, host: d.host,
    network: init.network.selected, exposure: d.exposure, maxUsers: d.maxUsers, protected: d.protected,
    autoRestart: d.autoRestart, healthCheck: d.healthCheck, advertise: d.advertise,
  };
  const fields: Field[] = [
    { key: "name", label: "Project name", kind: "text" },
    { key: "command", label: "Start command", kind: "text" },
    { key: "runtime", label: "Runtime", kind: "choice", options: init.options.runtimes.map((r) => ({ value: r, label: r })) },
    { key: "port", label: "Port", kind: "number" },
    ...(init.network.interfaces.length > 1
      ? [{ key: "network" as const, label: "Network", kind: "choice" as const, options: init.network.interfaces.map((i) => ({ value: i.address, label: `${i.label ?? i.name}  ${i.address}` })) }]
      : []),
    { key: "exposure", label: "Exposure", kind: "choice", options: [{ value: "local", label: "Local only" }, { value: "lan", label: "LAN" }, { value: "public", label: "Public tunnel" }] },
    { key: "maxUsers", label: "Max active users", kind: "number" },
    { key: "protected", label: "Invite-only link", kind: "toggle" },
    { key: "autoRestart", label: "Auto restart", kind: "toggle" },
    { key: "healthCheck", label: "Health check", kind: "toggle" },
    { key: "advertise", label: "Network discovery", kind: "toggle" },
  ];
  let cursor = 0;
  let lines = 0;

  const show = (f: Field): string => {
    const v = values[f.key];
    if (f.kind === "toggle") return v ? "[✓]" : "[ ]";
    if (f.kind === "choice") return `‹ ${f.options.find((o) => o.value === v)?.label ?? String(v)} ›`;
    if (f.kind === "number") return f.key === "port" ? (v ? String(v) : `Auto${init.sharePort ? ` (${init.sharePort})` : ""}`) : f.key === "maxUsers" && !v ? "0 (unlimited)" : String(v);
    return String(v ?? "");
  };

  const render = () => {
    if (lines) output.write(`${ESC}${lines}A${ESC}0J`);
    const p = init.project;
    const host = values.exposure === "local" ? "localhost" : values.network || "localhost";
    const port = values.port ?? init.sharePort ?? "auto";
    const out = [
      "",
      `${bold("Host with Rynk")}   ${bold(p.name)}  ${dim([p.framework, p.runtimeLabel, p.packageManager].filter(Boolean).join(" · "))}`,
      "",
      ...fields.map((f, i) => {
        const label = f.label.padEnd(18);
        const val = show(f);
        return i === cursor ? `${bold("›")} ${label} ${inverse(` ${val} `)}` : `  ${dim(label)} ${val}`;
      }),
      "",
      `  Share link  http://${host}:${port}${values.exposure === "public" ? dim("  + public tunnel (anyone with the link)") : ""}`,
      dim("  ↑↓ move  ←→ change  space toggle  type to edit  Enter start  Esc cancel"),
    ];
    output.write(out.join("\n") + "\n");
    lines = out.length;
  };

  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    const finish = (result: PopupSettings | null) => {
      input.off("keypress", onKey);
      if (input.isTTY) input.setRawMode(Boolean(wasRaw));
      input.pause();
      resolve(result);
    };
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      const f = fields[cursor]!;
      if (key.ctrl && key.name === "c") return finish(null);
      if (key.name === "escape") return finish(null);
      if (key.name === "return") return finish(values);
      if (key.name === "up") cursor = (cursor + fields.length - 1) % fields.length;
      else if (key.name === "down" || key.name === "tab") cursor = (cursor + 1) % fields.length;
      else if (f.kind === "toggle" && (key.name === "space" || key.name === "left" || key.name === "right")) (values[f.key] as boolean) = !values[f.key];
      else if (f.kind === "choice" && (key.name === "left" || key.name === "right")) {
        const idx = f.options.findIndex((o) => o.value === values[f.key]);
        const next = f.options[(idx + (key.name === "right" ? 1 : f.options.length - 1)) % f.options.length]!;
        (values[f.key] as string) = next.value;
      } else if (f.kind === "number") {
        const cur = Number(values[f.key] ?? 0);
        if (key.name === "backspace") (values[f.key] as number | null) = Math.floor(cur / 10) || (f.key === "port" ? null : 0);
        else if (str && /^\d$/.test(str)) (values[f.key] as number) = Math.min(f.key === "port" ? 65535 : 100000, cur * 10 + Number(str));
        else if (key.name === "left" || key.name === "right") (values[f.key] as number) = Math.max(0, cur + (key.name === "right" ? 1 : -1));
      } else if (f.kind === "text") {
        if (key.name === "backspace") (values[f.key] as string) = String(values[f.key] ?? "").slice(0, -1);
        else if (str && str.length === 1 && str >= " ") (values[f.key] as string) = String(values[f.key] ?? "") + str;
      }
      render();
    };
    input.on("keypress", onKey);
    render();
  });
}
