#!/usr/bin/env node
import { buildProgram } from "./program.js";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`Rynk needs Node.js 22.13 or newer (you have ${process.versions.node}).\nInstall it from https://nodejs.org and try again.\n`);
  process.exit(1);
}

// node:sqlite is stable enough for Rynk's use; don't alarm users with its experimental notice.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (/SQLite is an experimental feature/.test(typeof w === "string" ? w : w.message)) return;
  return (emit as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

await buildProgram().parseAsync(process.argv);
