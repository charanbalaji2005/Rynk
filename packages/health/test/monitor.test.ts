import { describe, expect, it } from "vitest";
import { HealthMonitor } from "../src/index.js";

const spec = { type: "http" as const, path: "/", intervalMs: 1000, timeoutMs: 100, startupTimeoutMs: 1000 };
const ok = { ok: true, latencyMs: 1 };
const bad = { ok: false, latencyMs: 1, error: "ECONNREFUSED" };

function monitor(opts = {}) {
  const changes: string[] = [];
  const m = new HealthMonitor(spec, () => ({ host: "127.0.0.1", port: 1, isAlive: () => true }), (_f, to) => changes.push(to), opts);
  m.status = "HEALTHY";
  return { m, changes };
}

describe("HealthMonitor hysteresis", () => {
  it("DEGRADED on one failure, UNHEALTHY after the threshold", () => {
    const { m, changes } = monitor({ failureThreshold: 3 });
    m.record(bad);
    m.record(bad);
    m.record(bad);
    expect(changes).toEqual(["DEGRADED", "UNHEALTHY"]);
  });
  it("needs consecutive successes to recover", () => {
    const { m, changes } = monitor({ successThreshold: 2 });
    m.record(bad);
    m.record(ok);
    expect(m.status).toBe("DEGRADED");
    m.record(ok);
    expect(changes).toEqual(["DEGRADED", "HEALTHY"]);
  });
  it("ignores failures during the grace period", () => {
    const { m, changes } = monitor({ gracePeriodMs: 60_000 });
    m.start();
    m.record(bad);
    m.stop();
    expect(changes).toEqual([]);
  });
});
