import { RynkError, type RuntimeKind } from "@rynk/core";
import { CustomRuntime, NativeRuntime } from "./native.js";
import { StaticRuntime } from "./static.js";
import { ComposeRuntime, DockerRuntime } from "./docker.js";
import type { RuntimeAdapter } from "./types.js";

export class RuntimeRegistry {
  private adapters = new Map<string, RuntimeAdapter>();

  constructor(adapters: RuntimeAdapter[] = [new NativeRuntime(), new CustomRuntime(), new StaticRuntime(), new DockerRuntime(), new ComposeRuntime()]) {
    for (const a of adapters) this.register(a);
  }

  register(a: RuntimeAdapter) {
    this.adapters.set(a.kind, a);
  }

  get(kind: RuntimeKind | string): RuntimeAdapter {
    const a = this.adapters.get(kind);
    if (!a) throw new RynkError("RUNTIME_UNAVAILABLE", `No runtime adapter registered for "${kind}".`);
    return a;
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}

/** Exponential backoff with jitter for crash restarts: 1s, 2s, 4s … capped. */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number): number {
  const base = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt - 1));
  // Jitter spreads restarts out, but the configured maximum is a hard ceiling.
  return Math.min(maxMs, Math.round(base * (0.85 + Math.random() * 0.3)));
}
