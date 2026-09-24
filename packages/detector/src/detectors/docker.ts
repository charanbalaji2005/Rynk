import { parse as parseYaml } from "yaml";
import type { DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import type { ProjectContext } from "../context.js";

/** Parse the first EXPOSE port from a Dockerfile. */
export function exposedPort(dockerfile: string): number | undefined {
  const m = /^\s*EXPOSE\s+(\d+)/im.exec(dockerfile);
  return m ? Number(m[1]) : undefined;
}

export const dockerDetector: Detector = {
  name: "docker",
  detect(ctx: ProjectContext): DetectionResult | null {
    const df = ctx.read("Dockerfile");
    if (df === null) return null;
    const port = exposedPort(df);
    return {
      detector: "docker",
      language: "container",
      runtime: "docker",
      // Below native detectors: native is faster; `--runtime docker` forces containers.
      confidence: 0.6,
      evidence: ["Dockerfile", ...(port ? [`EXPOSE ${port}`] : [])],
      container: { dockerfile: "Dockerfile", ...(port ? { containerPort: port } : {}) },
      binding: { portControllable: true },
      ...(port ? { defaultPort: port } : {}),
      ...(port ? {} : { warnings: ["Dockerfile has no EXPOSE; set docker.containerPort in rynk.yaml."] }),
    };
  },
};

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

export const composeDetector: Detector = {
  name: "compose",
  detect(ctx: ProjectContext): DetectionResult | null {
    const file = COMPOSE_FILES.find((f) => ctx.exists(f));
    if (!file) return null;
    let service: string | undefined;
    let containerPort: number | undefined;
    let hostPort: number | undefined;
    try {
      const doc = parseYaml(ctx.read(file) ?? "") as { services?: Record<string, { ports?: Array<string | number | { target?: number; published?: number | string }> }> };
      for (const [name, svc] of Object.entries(doc.services ?? {})) {
        const p = svc.ports?.[0];
        if (p === undefined) continue;
        service = name;
        if (typeof p === "object") {
          containerPort = p.target;
          hostPort = p.published ? Number(p.published) : undefined;
        } else {
          const parts = String(p).split("/")[0]!.split(":");
          containerPort = Number(parts.at(-1));
          hostPort = parts.length > 1 ? Number(parts.at(-2)) : undefined;
        }
        break;
      }
    } catch {
      /* invalid compose file — docker compose will report the real error */
    }
    return {
      detector: "compose",
      language: "container",
      runtime: "compose",
      confidence: 0.65,
      evidence: [file, ...(service ? [`web service: ${service}`] : [])],
      container: { composeFile: file, ...(service ? { service } : {}), ...(containerPort ? { containerPort } : {}) },
      binding: { portControllable: false },
      ...(hostPort ? { defaultPort: hostPort } : containerPort ? { defaultPort: containerPort } : {}),
    };
  },
};
