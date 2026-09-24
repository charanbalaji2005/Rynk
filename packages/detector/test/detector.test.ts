import { describe, expect, it } from "vitest";
import { DetectorRegistry } from "../src/index.js";
import { fixture, pkg } from "../../../tests/helpers/fixtures.js";

const detect = async (files: Record<string, string>, prefer?: "docker") => (await new DetectorRegistry().detect(fixture(files), prefer ? { prefer } : {})).best;

describe("node detection", () => {
  it("detects Vite and injects host/port flags after --", async () => {
    const r = await detect({ "package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "^6" } }) });
    expect(r?.framework).toBe("Vite");
    expect(r?.defaultPort).toBe(5173);
    expect(r?.start?.display).toBe("npm run dev");
    expect(r?.binding.args).toEqual(expect.arrayContaining(["--", "--host", "--port", "--strictPort"]));
    expect(r?.binding.portControllable).toBe(true);
  });
  it("detects Next.js", async () => {
    const r = await detect({ "package.json": pkg({ scripts: { dev: "next dev", start: "next start", build: "next build" }, dependencies: { next: "15" } }) });
    expect(r?.framework).toMatch(/Next/);
    expect(r?.defaultPort).toBe(3000);
  });
  it("detects Express via the start script", async () => {
    const r = await detect({ "package.json": pkg({ scripts: { start: "node index.js" }, dependencies: { express: "^4" } }), "index.js": "" });
    expect(r?.framework).toBe("Express");
    expect(r?.start?.display).toBe("npm run start");
  });
  it("uses the lockfile's package manager", async () => {
    const r = await detect({ "package.json": pkg({ scripts: { start: "node x.js" } }), "pnpm-lock.yaml": "" });
    expect(r?.install?.[0]?.file).toBe("pnpm");
  });
});

describe("python detection", () => {
  it("detects Flask and uses a project virtualenv", async () => {
    const r = await detect({ "requirements.txt": "flask\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n" });
    expect(r?.framework).toBe("Flask");
    expect(r?.install?.[0]?.args).toContain("venv");
    expect(r?.start?.file).toMatch(/\.venv/);
  });
  it("detects FastAPI", async () => {
    const r = await detect({ "requirements.txt": "fastapi\nuvicorn\n", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n" });
    expect(r?.framework).toBe("FastAPI");
    expect(r?.start?.display).toMatch(/uvicorn main:app/);
  });
  it("detects Django", async () => {
    const r = await detect({ "requirements.txt": "django\n", "manage.py": "#!/usr/bin/env python\n" });
    expect(r?.framework).toBe("Django");
    expect(r?.start?.display).toMatch(/manage\.py runserver/);
  });
});

describe("other ecosystems", () => {
  it("detects Go", async () => {
    const r = await detect({ "go.mod": "module x\n\ngo 1.22\n", "main.go": "package main" });
    expect(r?.language).toBe("go");
  });
  it("detects Rust", async () => {
    const r = await detect({ "Cargo.toml": '[package]\nname = "x"\nversion = "0.1.0"\n', "src/main.rs": "fn main(){}" });
    expect(r?.language).toBe("rust");
  });
  it("detects Spring Boot", async () => {
    const r = await detect({ "pom.xml": "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>" });
    expect(r?.framework).toMatch(/Spring/);
  });
  it("detects a static site", async () => {
    const r = await detect({ "index.html": "<h1>hi</h1>" });
    expect(r?.runtime).toBe("static");
  });
  it("detects Procfile web processes", async () => {
    const r = await detect({ Procfile: "web: ./server --port $PORT\n", server: "" });
    expect(r?.start?.display).toContain("--port");
  });
});

describe("docker and ranking", () => {
  const files = { "package.json": pkg({ scripts: { start: "node s.js" } }), "s.js": "", Dockerfile: "FROM node:22\nEXPOSE 8080\n" };
  it("prefers the native runtime when both exist", async () => {
    expect((await detect(files))?.runtime).toBe("native");
  });
  it("uses Docker when asked", async () => {
    const r = await detect(files, "docker");
    expect(r?.runtime).toBe("docker");
    expect(r?.defaultPort).toBe(8080);
  });
  it("returns nothing for an empty folder", async () => {
    expect(await detect({ "notes.txt": "hi" })).toBeNull();
  });
});

describe("package managers and lockfiles", () => {
  it("reports the package manager on the result", async () => {
    expect((await detect({ "package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }), "pnpm-lock.yaml": "" }))?.packageManager).toBe("pnpm");
    expect((await detect({ "requirements.txt": "flask\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n" }))?.packageManager).toBe("pip");
    expect((await detect({ "go.mod": "module x\n", "main.go": "" }))?.packageManager).toBe("go");
  });
  it("warns instead of silently guessing when lockfiles conflict", async () => {
    const r = await detect({ "package.json": pkg({ scripts: { start: "node x.js" } }), "package-lock.json": "{}", "yarn.lock": "" });
    expect(r?.warnings?.join(" ")).toMatch(/Several lockfiles/);
  });
});
