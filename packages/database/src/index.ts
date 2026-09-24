import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema.js";
import { MIGRATIONS } from "./migrations.js";

// node:sqlite ships with Node ≥ 22.5 — no native addon to compile.
// Loaded via require so the ExperimentalWarning filter below runs first.
type SqliteModule = typeof import("node:sqlite");
const require = createRequire(import.meta.url);

function loadSqlite(): SqliteModule {
  const orig = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    const msg = typeof w === "string" ? w : w.message;
    if (/SQLite is an experimental feature/.test(msg)) return;
    return (orig as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = orig;
  }
}

export type RynkDatabase = SqliteRemoteDatabase<typeof schema>;

export interface DatabaseHandle {
  db: RynkDatabase;
  raw: import("node:sqlite").DatabaseSync;
  close(): void;
}

export function openDatabase(file: string): DatabaseHandle {
  const { DatabaseSync } = loadSqlite();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(raw);

  // Drizzle's sqlite-proxy driver lets us plug in any SQLite engine.
  const stmts = new Map<string, import("node:sqlite").StatementSync>();
  const prepare = (sql: string) => {
    let s = stmts.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      stmts.set(sql, s);
      if (stmts.size > 500) stmts.delete(stmts.keys().next().value!);
    }
    return s;
  };
  const toRow = (r: unknown) => (r && typeof r === "object" ? Object.values(r as Record<string, unknown>) : r);
  const db = drizzle(
    async (sql, params, method) => {
      const s = prepare(sql);
      const p = params as Array<string | number | bigint | null | Uint8Array>;
      if (method === "run") {
        s.run(...p);
        return { rows: [] };
      }
      if (method === "get") {
        const r = s.get(...p);
        return { rows: (r ? toRow(r) : undefined) as unknown[] };
      }
      return { rows: s.all(...p).map(toRow) as unknown[] };
    },
    { schema },
  );
  return { db, raw, close: () => raw.close() };
}

export function migrate(raw: import("node:sqlite").DatabaseSync): number {
  raw.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const applied = new Set((raw.prepare("SELECT id FROM _migrations").all() as Array<{ id: number }>).map((r) => r.id));
  let n = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    raw.exec("BEGIN");
    try {
      raw.exec(m.sql);
      raw.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, Date.now());
      raw.exec("COMMIT");
      n++;
    } catch (e) {
      raw.exec("ROLLBACK");
      throw e;
    }
  }
  return n;
}

export * as schema from "./schema.js";
export { MIGRATIONS } from "./migrations.js";
export { eq, and, desc, asc, gt, lt, inArray, sql } from "drizzle-orm";
