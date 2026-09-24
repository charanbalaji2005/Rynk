import fs from "node:fs";
import path from "node:path";
import type { LogEntry } from "@rynk/core";
import { defaultRedactor, type Redactor } from "@rynk/security";

export type LogLevel = LogEntry["level"];
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (entry: LogEntry) => void;

export interface LoggerOptions {
  level?: LogLevel;
  source?: string;
  sinks?: LogSink[];
  redactor?: Redactor;
  context?: Partial<Pick<LogEntry, "projectId" | "deploymentId">>;
}

/** Structured logger. Every entry passes through the redactor first. */
export class Logger {
  private readonly level: LogLevel;
  private readonly sinks: LogSink[];
  private readonly redactor: Redactor;
  readonly source: string;
  private readonly context: LoggerOptions["context"];

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? ((process.env.RYNK_LOG_LEVEL as LogLevel) || "info");
    this.sinks = opts.sinks ?? [];
    this.redactor = opts.redactor ?? defaultRedactor;
    this.source = opts.source ?? "rynk";
    this.context = opts.context ?? {};
  }

  child(source: string, context: LoggerOptions["context"] = {}): Logger {
    return new Logger({
      level: this.level,
      sinks: this.sinks,
      redactor: this.redactor,
      source,
      context: { ...this.context, ...context },
    });
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  log(level: LogLevel, message: string, metadata?: Record<string, unknown>, stream?: LogEntry["stream"]) {
    if (ORDER[level] < ORDER[this.level]) return;
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source: this.source,
      message: this.redactor.redact(message),
      ...this.context,
      ...(stream ? { stream } : {}),
      ...(metadata ? { metadata: JSON.parse(this.redactor.redact(JSON.stringify(metadata))) } : {}),
    };
    for (const s of this.sinks) {
      try {
        s(entry);
      } catch {
        /* a failing sink must never crash the daemon */
      }
    }
  }

  debug(m: string, meta?: Record<string, unknown>) { this.log("debug", m, meta); }
  info(m: string, meta?: Record<string, unknown>) { this.log("info", m, meta); }
  warn(m: string, meta?: Record<string, unknown>) { this.log("warn", m, meta); }
  error(m: string, meta?: Record<string, unknown>) { this.log("error", m, meta); }
}

/** JSON-lines file sink with size-based multi-generation rotation and bounded disk usage. */
export function fileSink(file: string, maxBytes = 10 * 1024 * 1024, maxFiles = 3): LogSink {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let stream = fs.createWriteStream(file, { flags: "a" });
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  return (e) => {
    const line = JSON.stringify(e) + "\n";
    size += Buffer.byteLength(line);
    if (size > maxBytes) {
      stream.end();
      try {
        for (let i = maxFiles - 1; i >= 1; i--) {
          const src = `${file}.${i}`;
          const dest = `${file}.${i + 1}`;
          if (fs.existsSync(src)) {
            if (i === maxFiles - 1) {
              fs.rmSync(src, { force: true });
            } else {
              fs.renameSync(src, dest);
            }
          }
        }
        if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
      } catch {
        /* ignore */
      }
      stream = fs.createWriteStream(file, { flags: "a" });
      size = Buffer.byteLength(line);
    }
    stream.write(line);
  };
}

/** Human-readable stderr sink (used in foreground mode / debug). */
export function consoleSink(minLevel: LogLevel = "info"): LogSink {
  return (e) => {
    if (ORDER[e.level] < ORDER[minLevel]) return;
    const t = new Date(e.timestamp).toISOString().slice(11, 19);
    process.stderr.write(`${t} ${e.level.padEnd(5)} [${e.source}] ${e.message}\n`);
  };
}

/** Bounded in-memory ring buffer — used for fast log tailing. */
export class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {}
  push(v: T) {
    this.buf.push(v);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }
  toArray(): T[] {
    return [...this.buf];
  }
  tail(n: number): T[] {
    return this.buf.slice(-n);
  }
  clear() {
    this.buf = [];
  }
}
