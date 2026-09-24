import path from "node:path";
import { describe, expect, it } from "vitest";
import { applySettings, buildRequest, parseGitSource, wantsPopup } from "../src/index.js";

describe("buildRequest", () => {
  it("maps flags onto a deploy request", () => {
    const r = buildRequest(".", { port: "8080", cmd: "node x.js", local: true, install: false, env: ["A=1", "B=x=y"] }, true);
    expect(r).toMatchObject({ port: 8080, command: "node x.js", exposure: "local", install: false, foreground: true, env: { A: "1", B: "x=y" } });
    expect(path.isAbsolute(r.root)).toBe(true);
  });
  it("rejects bad ports and env pairs", () => {
    expect(() => buildRequest(".", { port: "http" }, false)).toThrow(/valid port/);
    expect(() => buildRequest(".", { env: ["NOEQUALS"] }, false)).toThrow(/KEY=value/);
  });
});

describe("parseGitSource", () => {
  it("expands shorthands", () => {
    expect(parseGitSource("github:acme/shop")).toMatchObject({ url: "https://github.com/acme/shop.git", slug: "acme-shop" });
    expect(parseGitSource("gitlab:a/b#main")).toMatchObject({ url: "https://gitlab.com/a/b.git", ref: "main" });
  });
  it("accepts git URLs and ignores local paths", () => {
    expect(parseGitSource("https://github.com/acme/shop")?.slug).toBe("acme-shop");
    expect(parseGitSource("git@github.com:acme/shop.git")?.url).toBe("git@github.com:acme/shop.git");
    expect(parseGitSource("./my-project")).toBeNull();
  });
});

describe("hosting flags", () => {
  it("maps access and exposure flags", () => {
    const r = buildRequest(".", { lan: true, public: true, maxUsers: "10", protected: true, advertise: false, restart: false, healthCheck: false, network: "wlan0" }, false);
    expect(r).toMatchObject({ exposure: "lan", public: true, maxUsers: 10, protected: true, advertise: false, restart: "never", healthCheck: false, network: "wlan0" });
    expect(() => buildRequest(".", { local: true, lan: true }, false)).toThrow(/can't be combined/);
    expect(() => buildRequest(".", { maxUsers: "-1" }, false)).toThrow(/limit/);
  });
});

describe("popup decisions", () => {
  it("never shows the popup for automation or explicit flags", () => {
    expect(wantsPopup({ yes: true })).toBe(false);
    expect(wantsPopup({ nonInteractive: true })).toBe(false);
    expect(wantsPopup({ json: true })).toBe(false);
    expect(wantsPopup({ popup: true }, {})).toBe(true);
    expect(wantsPopup({ popup: true, yes: true }, {})).toBe(false);
    expect(wantsPopup({}, { CI: "1" })).toBe(false);
  });

  it("applies the popup's choices on top of the request", () => {
    const init = { project: { name: "demo", command: "npm run dev" } } as never;
    const base = buildRequest(".", {}, true);
    const r = applySettings(base, { name: "shop", command: "npm run dev", runtime: "Auto", port: 8080, host: "Auto", network: "192.168.1.42", exposure: "public", maxUsers: 3, protected: true, autoRestart: false, healthCheck: true, advertise: false }, init);
    expect(r).toMatchObject({ name: "shop", port: 8080, network: "192.168.1.42", exposure: "lan", public: true, maxUsers: 3, protected: true, restart: "never", advertise: false });
    expect(r.command).toBeUndefined(); // unchanged detected command isn't forced
    const custom = applySettings(base, { name: "demo", command: "./serve", runtime: "Custom command", port: null, host: "Auto", network: "", exposure: "local", maxUsers: 0, protected: false, autoRestart: true, healthCheck: false, advertise: true }, init);
    expect(custom).toMatchObject({ command: "./serve", runtime: "custom", exposure: "local", healthCheck: false });
  });
});
