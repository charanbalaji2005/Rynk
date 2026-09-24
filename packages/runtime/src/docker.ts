import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmd, RynkError, slugify, type ProjectDefinition } from "@rynk/core";
import { runStep, spawnManaged, toolVersion } from "@rynk/process";
import { defaultRedactor, isSensitiveKey, sanitizeEnv } from "@rynk/security";
import { execa } from "execa";
import type { Availability, RuntimeAdapter, RuntimeContext, RuntimeInstance } from "./types.js";

/** Hardened defaults: drop risky capabilities, cap resources, no privilege escalation. */
export const SAFE_RUN_FLAGS = [
  "--cap-drop", "ALL",
  ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID", "NET_BIND_SERVICE", "KILL"].flatMap((c) => ["--cap-add", c]),
  "--security-opt", "no-new-privileges",
  "--pids-limit", "512",
  "--memory", "2g",
  "--cpus", "2",
];

async function dockerAvailable(): Promise<Availability> {
  const v = await toolVersion("docker", ["version", "--format", "{{.Server.Version}}"]);
  return v ? { ok: true, version: v } : { ok: false, reason: "Docker is not installed or the Docker daemon isn't running." };
}

const containerName = (p: ProjectDefinition) => `rynk-${slugify(p.name)}-${p.id.slice(4, 10)}`;
const imageName = (p: ProjectDefinition) => `rynk/${slugify(p.name)}:latest`;

export class DockerRuntime implements RuntimeAdapter {
  readonly kind = "docker" as const;

  available() {
    return dockerAvailable();
  }

  async install() {
    /* dependencies are installed inside the image build */
  }

  async build(p: ProjectDefinition, ctx: RuntimeContext) {
    const dockerfile = p.container?.dockerfile ?? "Dockerfile";
    if (!fs.existsSync(path.join(p.root, dockerfile))) throw new RynkError("BUILD_FAILED", `${dockerfile} not found.`);
    ctx.onLine(`$ docker build -t ${imageName(p)} -f ${dockerfile} .`, "system");
    const r = await runStep(cmd("docker", "build", "-t", imageName(p), "-f", dockerfile, "--label", `rynk.project=${p.id}`, "."), {
      cwd: p.root,
      env: sanitizeEnv(process.env, { DOCKER_BUILDKIT: "1" }),
      onLine: ctx.onLine,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (r.code !== 0) throw new RynkError("BUILD_FAILED", "Docker image build failed.", { causes: r.tail.slice(-8), suggestions: ["rynk logs"] });
  }

  async start(p: ProjectDefinition, ctx: RuntimeContext): Promise<RuntimeInstance> {
    const name = containerName(p);
    await execa("docker", ["rm", "-f", name], { reject: false });
    const cport = p.container?.containerPort ?? p.defaultPort ?? ctx.port;
    const publish = ctx.host === "127.0.0.1" ? `127.0.0.1:${ctx.port}:${cport}` : `${ctx.port}:${cport}`;
    const cidfile = path.join(os.tmpdir(), `${name}-${Date.now()}.cid`);

    // Env values are passed through the docker CLI's environment (`-e KEY`),
    // so secrets never appear in the process list.
    const appEnv: Record<string, string> = { PORT: String(cport), ...p.env };
    defaultRedactor.addFromEnv(appEnv);
    const envFlags = Object.keys(appEnv).flatMap((k) => ["-e", k]);
    const args = ["run", "--rm", "--name", name, "--cidfile", cidfile, "-p", publish, "--label", `rynk.project=${p.id}`, ...SAFE_RUN_FLAGS, ...envFlags, imageName(p)];
    ctx.onLine(`$ docker run ${publish} ${imageName(p)}${Object.keys(appEnv).some(isSensitiveKey) ? " (secrets redacted)" : ""}`, "system");
    const proc = spawnManaged(cmd("docker", ...args), { cwd: p.root, env: sanitizeEnv(process.env, appEnv), onLine: ctx.onLine });

    let containerId: string | undefined;
    for (let i = 0; i < 40 && !containerId && proc.alive; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        containerId = fs.readFileSync(cidfile, "utf8").trim().slice(0, 12) || undefined;
      } catch {
        /* not yet written */
      }
    }
    return {
      kind: "docker",
      ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
      ...(containerId ? { containerId } : {}),
      startedAt: proc.startedAt,
      command: { file: "docker", args, display: `docker run ${imageName(p)}` },
      alive: () => proc.alive,
      exited: proc.exited,
      stop: async () => {
        await execa("docker", ["stop", "-t", "5", name], { reject: false });
        await proc.kill(3000);
        fs.rmSync(cidfile, { force: true });
      },
      stats: async () => {
        const r = await execa("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", name], { reject: false });
        const [cpu, mem] = r.stdout.split("|");
        if (!cpu || !mem) return null;
        return { cpu: parseFloat(cpu), memoryBytes: parseMem(mem.split("/")[0]!.trim()) };
      },
    };
  }

  async cleanup(p: ProjectDefinition) {
    await execa("docker", ["rm", "-f", containerName(p)], { reject: false });
  }
}

export function parseMem(s: string): number {
  const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(s);
  if (!m) return 0;
  const mult: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, TB: 1e12 };
  return Math.round(Number(m[1]) * (mult[m[2]!.toUpperCase()] ?? 1));
}

export class ComposeRuntime implements RuntimeAdapter {
  readonly kind = "compose" as const;

  available() {
    return dockerAvailable();
  }
  async install() {}
  async build() {
    /* `up --build` handles it */
  }

  private base(p: ProjectDefinition) {
    return ["compose", "-p", containerName(p), "-f", p.container?.composeFile ?? "compose.yaml"];
  }

  async start(p: ProjectDefinition, ctx: RuntimeContext): Promise<RuntimeInstance> {
    const args = [...this.base(p), "up", "--build", "--remove-orphans"];
    ctx.onLine(`$ docker ${args.join(" ")}`, "system");
    const proc = spawnManaged(cmd("docker", ...args), { cwd: p.root, env: sanitizeEnv(process.env, p.env), onLine: ctx.onLine });
    return {
      kind: "compose",
      ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
      startedAt: proc.startedAt,
      command: { file: "docker", args, display: `docker compose up (${p.container?.composeFile})` },
      alive: () => proc.alive,
      exited: proc.exited,
      stop: async () => {
        await execa("docker", [...this.base(p), "down"], { cwd: p.root, reject: false });
        await proc.kill(3000);
      },
      stats: async () => null,
    };
  }

  async cleanup(p: ProjectDefinition) {
    await execa("docker", [...this.base(p), "down", "--remove-orphans"], { cwd: p.root, reject: false });
  }
}
