import http from "node:http";
import net from "node:net";
import { sleep, type HealthCheckSpec, type HealthStatus } from "@rynk/core";

export interface ProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

export function httpProbe(host: string, port: number, path = "/", timeoutMs = 3000, headers: Record<string, string> = {}): Promise<ProbeResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, method: "GET", timeout: timeoutMs, headers: { "user-agent": "rynk-health/1", accept: "*/*", ...headers } }, (res) => {
      res.resume();
      // Any non-5xx response proves the server is up and answering HTTP.
      // 4xx is fine: many APIs return 404 on "/".
      const status = res.statusCode ?? 0;
      resolve({ ok: status > 0 && status < 500, status, latencyMs: Date.now() - t0 });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ ok: false, latencyMs: Date.now() - t0, error: e.code ?? e.message }));
    req.end();
  });
}

export function tcpProbe(host: string, port: number, timeoutMs = 2000): Promise<ProbeResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean, error?: string) => {
      s.destroy();
      resolve({ ok, latencyMs: Date.now() - t0, ...(error ? { error } : {}) });
    };
    s.setTimeout(timeoutMs, () => done(false, "timeout"));
    s.once("connect", () => done(true));
    s.once("error", (e: NodeJS.ErrnoException) => done(false, e.code ?? e.message));
  });
}

export interface ProbeTarget {
  host: string;
  port: number;
  isAlive: () => boolean;
  runCommand?: () => Promise<boolean>;
}

export async function probe(spec: HealthCheckSpec, t: ProbeTarget): Promise<ProbeResult> {
  switch (spec.type) {
    case "none":
      return { ok: true, latencyMs: 0 };
    case "process":
      return { ok: t.isAlive(), latencyMs: 0 };
    case "tcp":
      return tcpProbe(t.host, t.port, spec.timeoutMs);
    case "command": {
      const t0 = Date.now();
      const ok = t.runCommand ? await t.runCommand() : false;
      return { ok, latencyMs: Date.now() - t0 };
    }
    case "http":
    default:
      return httpProbe(t.host, t.port, spec.path ?? "/", spec.timeoutMs);
  }
}

/**
 * Poll until healthy or the startup budget runs out. Backs off gently
 * (250ms → 2s) so fast apps go live quickly and slow JVM builds aren't hammered.
 */
export async function waitForHealthy(spec: HealthCheckSpec, target: ProbeTarget | (() => ProbeTarget), opts: { signal?: AbortSignal; onAttempt?: (r: ProbeResult, n: number) => void } = {}): Promise<ProbeResult> {
  const deadline = Date.now() + spec.startupTimeoutMs;
  let delay = 250;
  let attempt = 0;
  let last: ProbeResult = { ok: false, latencyMs: 0, error: "not started" };
  while (Date.now() < deadline) {
    const t = typeof target === "function" ? target() : target;
    if (!t.isAlive()) return { ok: false, latencyMs: 0, error: "process exited" };
    last = await probe(spec, t);
    opts.onAttempt?.(last, ++attempt);
    if (last.ok) return last;
    await sleep(delay, opts.signal);
    delay = Math.min(delay * 1.5, 2000);
  }
  return { ...last, ok: false, error: last.error ?? "timeout" };
}

/**
 * Continuous health monitor with hysteresis: one failure → DEGRADED,
 * three consecutive → UNHEALTHY, so a single slow response doesn't flap state.
 */
export interface MonitorOptions {
  /** Consecutive failures before UNHEALTHY (one failure is DEGRADED). */
  failureThreshold?: number;
  /** Consecutive successes needed to return to HEALTHY after a problem. */
  successThreshold?: number;
  /** Ignore failures for this long after start (warm-up, JIT, first compile). */
  gracePeriodMs?: number;
}

/**
 * Continuous health monitor with hysteresis in both directions: a failure
 * makes the app DEGRADED, `failureThreshold` consecutive failures UNHEALTHY,
 * and it takes `successThreshold` consecutive successes to be HEALTHY again —
 * so one slow response never flaps state. Failures inside the grace period
 * after start are not counted.
 */
export class HealthMonitor {
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private successes = 0;
  private startedAt = 0;
  private readonly o: Required<MonitorOptions>;
  status: HealthStatus = "UNKNOWN";

  constructor(
    private readonly spec: HealthCheckSpec,
    private readonly target: () => ProbeTarget,
    private readonly onChange: (from: HealthStatus, to: HealthStatus, r: ProbeResult) => void,
    opts: MonitorOptions = {},
  ) {
    this.o = { failureThreshold: opts.failureThreshold ?? 3, successThreshold: opts.successThreshold ?? 2, gracePeriodMs: opts.gracePeriodMs ?? 0 };
  }

  set(to: HealthStatus, r: ProbeResult = { ok: to === "HEALTHY", latencyMs: 0 }) {
    if (to === this.status) return;
    const from = this.status;
    this.status = to;
    this.onChange(from, to, r);
  }

  /** Apply one probe result (exposed for tests). */
  record(r: ProbeResult) {
    if (r.ok) {
      this.failures = 0;
      this.successes++;
      if (this.status === "HEALTHY" || this.status === "UNKNOWN" || this.status === "STARTING" || this.successes >= this.o.successThreshold) this.set("HEALTHY", r);
      return;
    }
    this.successes = 0;
    if (Date.now() - this.startedAt < this.o.gracePeriodMs) return;
    this.failures++;
    this.set(this.failures >= this.o.failureThreshold ? "UNHEALTHY" : "DEGRADED", r);
  }

  start() {
    this.stop();
    this.startedAt = Date.now();
    if (this.spec.type === "none") return;
    const tick = async () => {
      this.record(await probe(this.spec, this.target()));
      this.timer = setTimeout(tick, this.spec.intervalMs);
      this.timer.unref();
    };
    this.timer = setTimeout(tick, this.spec.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
