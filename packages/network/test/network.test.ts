import { describe, expect, it } from "vitest";
import { EventBus } from "@rynk/events";
import { buildUrls, classifyInterface, isPrivateIPv4, listInterfaces, NetworkWatcher, primaryInterface } from "../src/index.js";

const iface = (address: string, internal = false) => [{ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` }];

describe("interface classification", () => {
  it.each([["wlan0", "wifi"], ["Wi-Fi", "wifi"], ["eth0", "ethernet"], ["en0", "ethernet"], ["docker0", "virtual"], ["utun3", "vpn"], ["tailscale0", "vpn"], ["lo", "loopback"]])("%s is %s", (n, k) => {
    expect(classifyInterface(n)).toBe(k);
  });
  it("recognises private ranges", () => {
    expect(isPrivateIPv4("192.168.1.20")).toBe(true);
    expect(isPrivateIPv4("10.0.0.2")).toBe(true);
    expect(isPrivateIPv4("172.20.1.1")).toBe(true);
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
  });
  it("ranks real LAN interfaces above Docker and VPNs", () => {
    const list = listInterfaces({ docker0: iface("172.17.0.1"), utun2: iface("10.8.0.2"), wlan0: iface("192.168.1.42"), lo: iface("127.0.0.1", true) });
    expect(primaryInterface(list)?.address).toBe("192.168.1.42");
    expect(list.find((i) => i.address === "127.0.0.1")).toBeUndefined();
  });
});

describe("URL building", () => {
  const interfaces = listInterfaces({ wlan0: iface("192.168.1.42"), eth0: iface("10.0.0.5") });
  it("builds local and network URLs", () => {
    const u = buildUrls({ port: 5173, exposure: "lan", interfaces });
    expect(u.local).toBe("http://localhost:5173");
    expect(u.network).toMatch(/^http:\/\/(10\.0\.0\.5|192\.168\.1\.42):5173$/);
    expect(u.networkAll).toHaveLength(2);
  });
  it("omits network URLs in local mode", () => {
    expect(buildUrls({ port: 3000, exposure: "local", interfaces }).network).toBeUndefined();
  });
});

describe("NetworkWatcher", () => {
  it("emits network.changed when addresses change", () => {
    const bus = new EventBus();
    let current = listInterfaces({ wlan0: iface("192.168.1.42") });
    const w = new NetworkWatcher(bus, 1000, () => current);
    const seen: string[] = [];
    bus.on("network.changed", (e) => seen.push(e.payload.primary?.address ?? ""));
    expect(w.check()).toBe(false);
    current = listInterfaces({ wlan0: iface("192.168.7.9") });
    expect(w.check()).toBe(true);
    expect(seen).toEqual(["192.168.7.9"]);
  });
});

describe("default-route awareness", () => {
  it("prefers the interface the OS routes through, even over a name that looks better", () => {
    const raw = { eth0: iface("10.0.0.5"), wlan0: iface("192.168.1.42") };
    expect(primaryInterface(listInterfaces(raw))?.address).toBe("10.0.0.5"); // ethernet by default
    const routed = listInterfaces(raw, { route: { source: "192.168.1.42", gateway: "192.168.1.1" } });
    expect(primaryInterface(routed)).toMatchObject({ address: "192.168.1.42", defaultRoute: true, gateway: "192.168.1.1" });
  });
  it("never returns unusable addresses", () => {
    const list = listInterfaces({ a: iface("169.254.3.4"), b: iface("0.0.0.0"), lo: iface("127.0.0.1", true) }, { includeIPv6: true });
    expect(list).toEqual([]);
  });
  it("finds the local route source without sending packets", async () => {
    const { routeSource } = await import("../src/index.js");
    const src = await routeSource("udp4");
    if (src) expect(src).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
