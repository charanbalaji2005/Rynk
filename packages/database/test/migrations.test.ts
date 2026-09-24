import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, openDatabase } from "../src/index.js";

describe("migrations", () => {
  it("upgrades a v1 database in place and keeps existing rows", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rynk-db-")), "rynk.db");
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
    raw.exec(MIGRATIONS[0]!.sql);
    raw.prepare("INSERT INTO _migrations VALUES (1, 'initial', 0)").run();
    raw.prepare("INSERT INTO projects VALUES ('p1','a','/a',NULL,NULL,'native','{}',0,0)").run();
    raw.close();
    const h = openDatabase(file);
    const tables = (h.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["hosting_sessions", "nodes"]));
    expect((h.raw.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n).toBe(1);
    const cols = (h.raw.prepare("PRAGMA table_info(logs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["hosting_session_id", "pid", "metadata"]));
    expect((h.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    h.close();
  });
});
