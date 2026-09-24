import path from "node:path";
import { RynkError, type CommandSpec } from "@rynk/core";
import { isInside } from "./paths.js";

/**
 * Validate a command before execution:
 *  - relative executables (./server, bin/app) must resolve inside the project;
 *  - absolute executables outside the project are rejected unless trusted;
 *  - shell mode is only allowed when the origin is the user (cli / rynk.yaml).
 */
export function validateCommand(
  command: CommandSpec,
  projectRoot: string,
  opts: { origin: "user" | "detector" | "remote"; trustAbsolute?: boolean } = { origin: "detector" },
): void {
  if (command.shell && opts.origin !== "user") {
    throw new RynkError("COMMAND_REJECTED", "Shell commands are only allowed when written by you.", {
      details: { command: command.display },
    });
  }
  if (opts.origin === "remote") {
    throw new RynkError("COMMAND_REJECTED", "Commands from remote sources require explicit approval.");
  }
  if (command.shell) return;
  const f = command.file;
  if (f.includes("\0")) throw new RynkError("COMMAND_REJECTED", "Invalid command.");
  const looksLikePath = f.includes("/") || f.includes("\\");
  if (!looksLikePath) return; // resolved via PATH, e.g. npm, python, go
  if (path.isAbsolute(f)) {
    if (!opts.trustAbsolute && !binInside(projectRoot, f)) {
      throw new RynkError("COMMAND_REJECTED", `Executable ${f} is outside the project directory.`, {
        suggestions: ["Put the command in rynk.yaml to confirm you trust it."],
      });
    }
    return;
  }
  const resolved = path.resolve(projectRoot, f);
  if (!binInside(projectRoot, resolved)) {
    throw new RynkError("COMMAND_REJECTED", `Executable ${f} escapes the project directory.`);
  }
}

/**
 * The executable's *directory* must be inside the project (directory symlinks
 * are resolved). The file itself may be a symlink out — that's how virtualenvs
 * and node_modules/.bin work — so it is not dereferenced.
 */
function binInside(projectRoot: string, file: string): boolean {
  return isInside(projectRoot, path.dirname(path.resolve(projectRoot, file)));
}
