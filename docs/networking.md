# Networking

## Local, LAN and public

| Mode | Who can open it | How |
| --- | --- | --- |
| Local | This computer | popup "Local only", `--local`, `network.exposure: local` |
| LAN (default) | Devices on the same network | automatic |
| Public | Anyone with the link | popup "Public tunnel", `--public`, `rynk share --public` |

Public access always needs an explicit action and still goes through the
access gateway (limits and invites apply).

## The share link

Rynk asks the operating system which local address carries the **default
route** (a connected UDP socket reveals it without sending a packet or running
a command — identical on Windows, macOS and Linux) and ranks that interface
first. After that it prefers private addresses and physical interfaces
(Ethernet, Wi-Fi, others, VPN) and never uses loopback, `0.0.0.0`,
link-local (169.254/16, fe80::) or Docker/WSL/VM adapters. IPv4 is preferred
for share links; IPv6 addresses are listed but not chosen automatically.
`rynk network` shows the default route and gateway. The best one's IP
goes in the link; pick another in the popup or with `--network wlan0` /
`--network 10.0.0.15`. `rynk network` lists them all.

When the address changes, Rynk updates the link, QR code, popup and discovery
announcement within about five seconds and prints the new link.

## Ports and binding

Your app listens on `127.0.0.1:<internal port>` (41000–41999). Rynk's access
gateway listens on the **share port** — the framework default (5173, 3000,
8000…) if free, otherwise the next free port, kept stable across restarts —
on `0.0.0.0` for LAN, `127.0.0.1` for local, or the specific interface you
chose. Rynk never kills another program to free a port.

| Port | What | Reachable from |
| --- | --- | --- |
| share port (e.g. 5173) | your app, via the gateway | LAN (or this computer in local mode) |
| 9876 | daemon control API | this computer only |
| 7777 | `http://<name>.localhost` names | this computer only |
| 7780 | read-only node info | LAN |
| 7779/udp, 5353/udp | discovery | LAN (multicast, never routed) |

Override with `RYNK_DAEMON_PORT`, `RYNK_PROXY_PORT`, `RYNK_NODE_PORT`,
`RYNK_DISCOVERY_PORT`, `RYNK_APP_PORT_MIN/MAX`.

## Protocols

HTTP, streaming responses, Server-Sent Events and WebSocket upgrades pass
through the gateway, so dev-server hot reload (Vite, Next.js, …) works over the
share link. Apps serving HTTPS themselves can be shared as TCP pass-through by
using `health.type: tcp`; the gateway speaks HTTP.

## Firewalls

Rynk never changes firewall settings. If an app answers locally but not over
the LAN, Rynk says so and `rynk doctor` explains what to allow: on
macOS/Windows accept the prompt for Node.js, on Windows make the Wi-Fi network
**Private**, on Linux `sudo ufw allow <share-port>/tcp`.
