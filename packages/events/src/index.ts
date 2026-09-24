import { EventEmitter } from "node:events";
import type { AccessConfig, ClientSession, DeploymentState, DeploymentURLs, HealthStatus, LogEntry, NetworkInterfaceInfo, Route, RuntimeMetrics, RynkNode } from "@rynk/core";

/**
 * Typed internal event bus. Subsystems never call each other for
 * notifications — they publish here, keeping the architecture decoupled.
 */
export interface RynkEvents {
  "project.detected": { projectId: string; name: string; language: string; framework?: string };
  "project.updated": { projectId: string };
  "deployment.created": { deploymentId: string; projectId: string };
  "deployment.state": { deploymentId: string; projectId: string; from: DeploymentState; to: DeploymentState; message?: string };
  "deployment.completed": { deploymentId: string; projectId: string; urls: DeploymentURLs };
  "deployment.failed": { deploymentId: string; projectId: string; error: { code: string; message: string; causes: string[]; suggestions: string[] } };
  "runtime.started": { deploymentId: string; projectId: string; pid?: number; containerId?: string };
  "runtime.stopped": { deploymentId: string; projectId: string; exitCode?: number | null };
  "runtime.crashed": { deploymentId: string; projectId: string; exitCode: number | null; signal?: string | null };
  "runtime.restarted": { deploymentId: string; projectId: string; attempt: number };
  "health.changed": { deploymentId: string; projectId: string; from: HealthStatus; to: HealthStatus };
  "network.changed": { previous: NetworkInterfaceInfo[]; current: NetworkInterfaceInfo[]; primary?: NetworkInterfaceInfo };
  "port.allocated": { projectId: string; port: number };
  "port.released": { projectId: string; port: number };
  "route.created": { route: Route };
  "route.removed": { routeId: string };
  "urls.updated": { deploymentId: string; projectId: string; urls: DeploymentURLs };
  "log.received": { entry: LogEntry };
  "metrics.updated": { deploymentId: string; projectId: string; metrics: RuntimeMetrics };
  "exposure.created": { projectId: string; url: string; provider: string };
  "exposure.closed": { projectId: string; provider: string };
  "access.session": { projectId: string; deploymentId: string; kind: "opened" | "idle" | "active" | "closed"; session: ClientSession; active: number; limit: number };
  "access.denied": { projectId: string; deploymentId: string; reason: "limit" | "protected" | "blocked" | "ended" | "rate"; clientAddress: string };
  "access.updated": { projectId: string; deploymentId: string; access: AccessConfig };
  "node.discovered": { node: RynkNode };
  "node.updated": { node: RynkNode };
  "node.lost": { node: RynkNode };
}

export type RynkEventName = keyof RynkEvents;
export interface EnvelopedEvent<K extends RynkEventName = RynkEventName> {
  type: K;
  timestamp: number;
  payload: RynkEvents[K];
}

export class EventBus {
  private readonly emitter = new EventEmitter({ captureRejections: true });

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  emit<K extends RynkEventName>(type: K, payload: RynkEvents[K]): void {
    const env: EnvelopedEvent<K> = { type, timestamp: Date.now(), payload };
    this.emitter.emit(type, env);
    this.emitter.emit("*", env);
  }

  on<K extends RynkEventName>(type: K, fn: (e: EnvelopedEvent<K>) => void): () => void {
    this.emitter.on(type, fn as (e: unknown) => void);
    return () => this.emitter.off(type, fn as (e: unknown) => void);
  }

  onAny(fn: (e: EnvelopedEvent) => void): () => void {
    this.emitter.on("*", fn);
    return () => this.emitter.off("*", fn);
  }

  once<K extends RynkEventName>(type: K, predicate: (p: RynkEvents[K]) => boolean = () => true, timeoutMs?: number): Promise<RynkEvents[K]> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const off = this.on(type, (e) => {
        if (!predicate(e.payload)) return;
        off();
        if (timer) clearTimeout(timer);
        resolve(e.payload);
      });
      if (timeoutMs) timer = setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
    });
  }
}
