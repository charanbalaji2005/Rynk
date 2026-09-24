import { describe, expect, it } from "vitest";
import { DetectorRegistry } from "@rynk/detector";
import { loadRynkYaml, renderRynkYaml, resolveProject } from "../src/index.js";
import { fixture, pkg } from "../../../tests/helpers/fixtures.js";

describe("configuration precedence", () => {
  it("CLI beats rynk.yaml beats detection", async () => {
    const root = fixture({ "package.json": pkg({ name: "meta-name", scripts: { dev: "vite" }, devDependencies: { vite: "6" } }), "rynk.yaml": "name: yaml-name\nserver:\n  port: 4000\n" });
    const det = (await new DetectorRegistry().detect(root)).best;
    const yaml = loadRynkYaml(root)!.config;
    const fromYaml = resolveProject({ root, yaml, detection: det, packageName: "meta-name" });
    expect(fromYaml.name).toBe("yaml-name");
    expect(fromYaml.port).toBe(4000);
    const fromCli = resolveProject({ root, yaml, detection: det, cli: { name: "cli-name", port: 5000 } });
    expect(fromCli.name).toBe("cli-name");
    expect(fromCli.port).toBe(5000);
    expect(fromCli.source).toEqual(expect.arrayContaining(["cli", "rynk.yaml", "detector", "defaults"]));
  });

  it("falls back to package metadata for the name", async () => {
    const root = fixture({ "package.json": pkg({ name: "@acme/Shop", scripts: { start: "node x.js" } }) });
    const det = (await new DetectorRegistry().detect(root)).best;
    expect(resolveProject({ root, detection: det, packageName: "@acme/Shop" }).name).toMatch(/shop/);
  });

  it("a user start command overrides a static detection", async () => {
    const root = fixture({ "index.html": "", "rynk.yaml": "start:\n  command: ./serve.sh\n", "serve.sh": "" });
    const det = (await new DetectorRegistry().detect(root)).best;
    const p = resolveProject({ root, yaml: loadRynkYaml(root)!.config, detection: det });
    expect(p.runtime).toBe("custom");
    expect(p.start.display).toBe("./serve.sh");
  });

  it("explains invalid rynk.yaml", () => {
    const root = fixture({ "rynk.yaml": "server:\n  port: not-a-port\nunknownKey: 1\n" });
    expect(() => loadRynkYaml(root)).toThrow(/invalid settings/);
  });

  it("requires shell: true for shell syntax", () => {
    const root = fixture({ "rynk.yaml": "start:\n  command: npm run build && npm start\n" });
    expect(() => resolveProject({ root, yaml: loadRynkYaml(root)!.config })).toThrow();
    const ok = fixture({ "rynk.yaml": "shell: true\nstart:\n  command: npm run build && npm start\n" });
    expect(resolveProject({ root: ok, yaml: loadRynkYaml(ok)!.config }).start.shell).toBe(true);
  });

  it("fails helpfully when nothing is detectable", () => {
    expect(() => resolveProject({ root: fixture({ "x.txt": "" }) })).toThrow(/couldn't work out/);
  });

  it("renders a rynk.yaml that loads back", async () => {
    const root = fixture({ "package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }) });
    const p = resolveProject({ root, detection: (await new DetectorRegistry().detect(root)).best });
    const out = fixture({ "rynk.yaml": renderRynkYaml(p) });
    expect(loadRynkYaml(out)?.config.name).toBe(p.name);
  });
});
