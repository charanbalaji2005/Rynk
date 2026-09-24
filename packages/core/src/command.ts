import type { CommandSpec } from "./types.js";

/**
 * Parse a command line into argv WITHOUT invoking a shell. Supports single
 * quotes, double quotes and backslash escapes. Shell operators (|, &&, ;, >,
 * $(...), backticks) are rejected unless the caller opts into shell mode,
 * which is only permitted for commands the user wrote in rynk.yaml / CLI.
 */
const SHELL_OPERATORS = /(^|[^\\])(\|\||&&|[|;<>`]|\$\()/;

export class CommandParseError extends Error {}

export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new CommandParseError(`Unterminated quote in command: ${input}`);
  if (has || cur) out.push(cur);
  return out;
}

export function containsShellOperators(input: string): boolean {
  // Strip quoted segments before checking.
  const unquoted = input.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "");
  return SHELL_OPERATORS.test(unquoted);
}

export function parseCommand(input: string, opts: { allowShell?: boolean } = {}): CommandSpec {
  const trimmed = input.trim();
  if (!trimmed) throw new CommandParseError("Command is empty");
  if (containsShellOperators(trimmed)) {
    if (!opts.allowShell) {
      throw new CommandParseError(
        `Command contains shell operators and shell mode is not enabled: ${trimmed}`,
      );
    }
    return { file: trimmed, args: [], display: trimmed, shell: true };
  }
  const [file, ...args] = tokenize(trimmed);
  return { file: file!, args, display: trimmed };
}

export function cmd(file: string, ...args: string[]): CommandSpec {
  const display = [file, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
  return { file, args, display };
}

export function withArgs(c: CommandSpec, extra: string[]): CommandSpec {
  if (c.shell) {
    const tail = extra.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
    return { ...c, file: `${c.file} ${tail}`, display: `${c.display} ${tail}` };
  }
  return cmd(c.file, ...c.args, ...extra);
}
