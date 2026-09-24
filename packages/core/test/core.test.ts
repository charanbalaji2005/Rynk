import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, containsShellOperators, interpolate, isTerminal, parseCommand, parseDuration, projectIdFor, RynkError, slugify, tokenize } from "../src/index.js";

describe("command parsing", () => {
  it("tokenizes quotes and escapes without a shell", () => {
    expect(tokenize(`node server.js --name "hello world" 'a b' c\\ d`)).toEqual(["node", "server.js", "--name", "hello world", "a b", "c d"]);
  });
  it("detects shell operators", () => {
    expect(containsShellOperators("npm run build && npm start")).toBe(true);
    expect(containsShellOperators("echo hi | cat")).toBe(true);
    expect(containsShellOperators("node server.js --flag=a")).toBe(false);
  });
  it("rejects shell syntax unless allowed", () => {
    expect(() => parseCommand("a && b")).toThrow();
    const c = parseCommand("a && b", { allowShell: true });
    expect(c.shell).toBe(true);
  });
  it("parses file and args", () => {
    const c = parseCommand("python -m flask run");
    expect(c.file).toBe("python");
    expect(c.args).toEqual(["-m", "flask", "run"]);
  });
});

describe("deployment state machine", () => {
  it("allows the happy path", () => {
    const path = ["CREATED", "DISCOVERING", "RESOLVING", "PREPARING", "INSTALLING", "BUILDING", "ALLOCATING", "STARTING", "HEALTH_CHECKING", "REGISTERING", "EXPOSING", "LIVE", "STOPPING", "STOPPED"] as const;
    for (let i = 1; i < path.length; i++) expect(() => assertTransition(path[i - 1], path[i])).not.toThrow();
  });
  it("never goes LIVE before health checking", () => {
    expect(canTransition("STARTING", "LIVE")).toBe(false);
    expect(canTransition("INSTALLING", "LIVE")).toBe(false);
  });
  it("crash restarts go through RESTARTING", () => {
    expect(canTransition("LIVE", "RESTARTING")).toBe(true);
    expect(canTransition("RESTARTING", "STARTING")).toBe(true);
  });
  it("knows terminal states", () => {
    expect(isTerminal("FAILED")).toBe(true);
    expect(isTerminal("LIVE")).toBe(false);
  });
});

describe("utilities", () => {
  it("slugifies names for URLs", () => {
    expect(slugify("My Cool App!")).toBe("my-cool-app");
    expect(slugify("@scope/pkg")).toMatch(/^[a-z0-9-]+$/);
  });
  it("derives stable project ids from paths", () => {
    expect(projectIdFor("/a/b")).toBe(projectIdFor("/a/b"));
    expect(projectIdFor("/a/b")).not.toBe(projectIdFor("/a/c"));
  });
  it("parses durations", () => {
    expect(parseDuration("30s", 0)).toBe(30_000);
    expect(parseDuration("2m", 0)).toBe(120_000);
    expect(parseDuration(undefined, 5)).toBe(5);
  });
  it("interpolates placeholders", () => {
    expect(interpolate("--port {port} --host {host}", { port: 3000, host: "0.0.0.0" })).toBe("--port 3000 --host 0.0.0.0");
  });
});

describe("RynkError", () => {
  it("maps OS errors to friendly ones", () => {
    const e = RynkError.from(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }));
    expect(e.code).toBe("PORT_UNAVAILABLE");
    expect(e.suggestions.length).toBeGreaterThan(0);
  });
  it("serializes causes and suggestions", () => {
    const j = new RynkError("NOT_FOUND", "nope", { causes: ["x"], suggestions: ["y"] }).toJSON();
    expect(j).toMatchObject({ code: "NOT_FOUND", message: "nope", causes: ["x"], suggestions: ["y"] });
  });
});

describe("runtime capabilities", async () => {
  const { runtimeCapabilities, packageManagerOf } = await import("../src/index.js");
  it("derives host/port control from the binding", () => {
    const vite = runtimeCapabilities({ runtime: "native", binding: { args: ["--", "--host", "{host}", "--port", "{port}"], env: { PORT: "{port}" }, portControllable: true }, health: { type: "http" } });
    expect(vite).toMatchObject({ supportsHostFlag: true, supportsPortFlag: true, supportsPortEnv: true, supportsHostEnv: false, supportsHealthCheck: true });
    const bare = runtimeCapabilities({ runtime: "custom", binding: { portControllable: false }, health: { type: "process" } });
    expect(bare).toMatchObject({ supportsHostFlag: false, supportsPortEnv: false, supportsHealthCheck: false });
  });
  it("names package managers from commands", () => {
    expect(packageManagerOf({ install: [{ file: "pnpm" }] })).toBe("pnpm");
    expect(packageManagerOf({ install: [{ file: "./mvnw" }] })).toBe("maven");
    expect(packageManagerOf({ start: { file: ".venv/bin/python" } })).toBe("pip");
  });
});
