import crypto from "node:crypto";
import os from "node:os";
import type { DeviceInfo } from "@rynk/core";
import type { NetworkWatcher } from "@rynk/network";
import { toolVersion } from "@rynk/process";
import type { Store } from "./store.js";

const RUNTIME_PROBES: Array<[string, string, string[]?]> = [
  ["node", "node"], ["python", process.platform === "win32" ? "python" : "python3"], ["docker", "docker"],
  ["go", "go", ["version"]], ["rust", "cargo"], ["java", "java", ["-version"]], ["dotnet", "dotnet"],
  ["php", "php"], ["ruby", "ruby"], ["deno", "deno"], ["bun", "bun"],
];

/**
 * The local Rynk agent's view of this machine. In multi-device mode each
 * machine's agent registers with a control plane and heartbeats; today the
 * control plane is the local daemon itself, so there's one device.
 */
export class DeviceAgent {
  private info: DeviceInfo | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly store: Store, private readonly network: NetworkWatcher) {}

  static deviceId(): string {
    const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.userInfo().username}`;
    return "dev_" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
  }

  async register(): Promise<DeviceInfo> {
    const runtimes: Record<string, string | null> = {};
    await Promise.all(RUNTIME_PROBES.map(async ([name, bin, args]) => (runtimes[name] = await toolVersion(bin, args))));
    this.info = {
      id: DeviceAgent.deviceId(),
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpus: os.cpus().length,
      memoryBytes: os.totalmem(),
      runtimes,
      addresses: this.network.current().map((i) => i.address),
      status: "ONLINE",
      lastHeartbeat: Date.now(),
      labels: { platform: process.platform },
    };
    await this.store.upsertDevice(this.info);
    return this.info;
  }

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => void this.heartbeat(), intervalMs);
    this.timer.unref();
  }

  async heartbeat() {
    if (!this.info) return;
    this.info = { ...this.info, addresses: this.network.current().map((i) => i.address), lastHeartbeat: Date.now(), status: "ONLINE" };
    await this.store.upsertDevice(this.info);
  }

  /** ONLINE → UNREACHABLE (>2 missed) → OFFLINE (>10 missed). State is never deleted. */
  static classify(lastHeartbeat: number, intervalMs = 30_000): DeviceInfo["status"] {
    const age = Date.now() - lastHeartbeat;
    return age < intervalMs * 2.5 ? "ONLINE" : age < intervalMs * 10 ? "UNREACHABLE" : "OFFLINE";
  }

  current() {
    return this.info;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
