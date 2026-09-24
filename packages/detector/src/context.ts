import fs from "node:fs";
import path from "node:path";

/** Read-only, cached view over a project directory for detectors. */
export class ProjectContext {
  private cache = new Map<string, string | null>();
  private listing: string[] | null = null;

  constructor(readonly root: string) {}

  path(...p: string[]): string {
    return path.join(this.root, ...p);
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.path(rel));
  }

  isDir(rel: string): boolean {
    try {
      return fs.statSync(this.path(rel)).isDirectory();
    } catch {
      return false;
    }
  }

  read(rel: string): string | null {
    if (this.cache.has(rel)) return this.cache.get(rel)!;
    let v: string | null = null;
    try {
      const st = fs.statSync(this.path(rel));
      if (st.isFile() && st.size < 2 * 1024 * 1024) v = fs.readFileSync(this.path(rel), "utf8");
    } catch {
      v = null;
    }
    this.cache.set(rel, v);
    return v;
  }

  json<T = Record<string, unknown>>(rel: string): T | null {
    const t = this.read(rel);
    if (!t) return null;
    try {
      return JSON.parse(t) as T;
    } catch {
      return null;
    }
  }

  files(): string[] {
    if (!this.listing) {
      try {
        this.listing = fs.readdirSync(this.root);
      } catch {
        this.listing = [];
      }
    }
    return this.listing;
  }

  findFile(pattern: RegExp): string | undefined {
    return this.files().find((f) => pattern.test(f));
  }

  /** Search a few likely source files for a regex — bounded to stay fast. */
  grep(candidates: string[], re: RegExp): string | undefined {
    return candidates.find((c) => {
      const t = this.read(c);
      return t !== null && re.test(t);
    });
  }
}

export const isWindows = process.platform === "win32";
