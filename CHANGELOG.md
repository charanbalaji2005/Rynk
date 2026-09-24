# Changelog

## [0.3.0] — 2026-09-24

Hardening release driven by a full code-level inspection against the product spec.

### Added
- **Hosting sessions** as a first-class, persisted record (node, project,
  deployment, host address, internal/share ports, local/share URLs, exposure,
  access mode, max and peak users, status, start/end). `rynk hosting` lists them;
  `status`/`inspect`/JSON show the current one.
- **Gateway abuse protection**: per-client rate limiting, per-session limits on
  concurrent requests and WebSockets, a global connection cap and request-size
  limits (declared and streamed).
- **Authenticated discovery**: Ed25519 node keys; node ids are derived from the
  public key and node descriptions are signed and time-stamped, so no machine
  can impersonate another node. Unsigned or mismatched nodes are ignored.
- **Default-route–aware IP selection** (no subprocess needed) plus best-effort
  default-gateway detection; `rynk network` shows the route and gateway.
- **Secrets at rest**: env values passed with `--env`/rynk.yaml are stored
  AES-256-GCM–encrypted (key in `RYNK_HOME/secret.key`, 0600); API responses
  redact secret-looking env values.
- Structured log metadata: node id, hosting session id and PID on every line;
  `rynk logs --since 2h`.
- `RuntimeCapabilities` (host/port via flags or env, health check, graceful
  stop) shown by `plan` and `inspect`; `packageManager` on every detection
  result; warnings when lockfiles conflict.
- `rynk share --copy` / `--qr`; status shows host IP and uptime; JSON gains
  `host`, `activeUsers`, `maxUsers`, `hostingSessionId`.
- Configurable client-data retention (`access.clientRetention`, `RYNK_CLIENT_RETENTION`).
- Firewall hint when the share link doesn't answer over the LAN address.
- Health monitor success threshold and grace period.
- Database migration 2 (hosting_sessions, nodes, log metadata, process
  command/cwd, extra indexes); retention for ended sessions and old nodes.
- Real end-to-end tests that drive the built CLI against real daemons.

### Fixed
- Rynk's own reachability probes were counted as active users.
- A node that said goodbye was flipped back to ONLINE by the next heartbeat
  sweep, then decayed to UNREACHABLE instead of staying OFFLINE.
- Log lines read from the database lacked the node id.
- `--tail` was ignored when combined with `--since`.
- Orphan reaping now also verifies command and working directory, not just PID
  and start time.
- The native-window test hung when `$DISPLAY` pointed at no X server.

### Changed
- Node identities from 0.2 (random id, no key) are replaced once by a keyed
  identity, so a machine's node id changes on first start of 0.3.


## [0.2.0] — 2026-09-24

CLI-first release: Rynk is a CLI plus a small native "Host this project"
window. The web dashboard is gone.

### Added
- **Native configuration popup** (Tk; WinForms on Windows without Python;
  in-terminal fallback) with project, runtime, command, port, host, network
  interface, exposure, max users, invite-only, auto-restart, health check and
  discovery settings; turns into a live view with share link, copy, QR, open,
  status/port/PID/uptime, connected clients, disconnect/block, limit, logs,
  restart and stop. Talks to the CLI over a stdio pipe.
- **Access gateway** in front of every app on its share port: enforced
  maximum active users, documented session model, client list, disconnect and
  block, invite-only links (expiring, limited uses, revocable), stable links
  across restarts with a "restarting" page, WebSocket/SSE/streaming passthrough.
- **LAN discovery** of other Rynk computers: persistent node identity, UDP
  multicast beacons + mDNS/DNS-SD, node registry with heartbeat/TTL
  (ONLINE/UNREACHABLE/OFFLINE), read-only node info endpoint, no node limit.
- Commands: `apps`, `nodes`, `network`, `network test`, `ports`, `clients`,
  `clients disconnect|unblock`, `limit`, `inspect`, `plan`; `share` now shows
  the link, QR and users and creates invites.
- Flags: `--lan`, `--public`, `--network`, `--max-users`, `--protected`,
  `--no-advertise`, `--no-restart`, `--no-health-check`, `--yes`,
  `--non-interactive`, `--popup`/`--no-popup`, `logs --tail`.
- In-place restarts (same deployment, link and sessions).
- `import { Rynk } from "rynk"`; Python `pip install rynk` now installs the
  `rynk` command (launcher for the Node CLI) and `from rynk import Rynk`.
- `rynk.yaml` `access:` block (`mode`, `maxUsers`, `idleTimeout`, `advertise`).

### Changed
- Apps listen on loopback; only the gateway faces the network, so "app only
  listens on localhost" no longer breaks LAN links.
- The built-in proxy serves `http://<name>.localhost:7777` on this computer
  only (it no longer exposes path routes to the LAN).

### Removed
- The web dashboard and its session/login endpoints.

### Fixed
- Discovery queries no longer treat cached announcements as proof of life.

## [0.1.0] — 2026-09-24
Initial release: daemon, CLI, detection for 15+ ecosystems, runtimes,
health-checked deployments, crash recovery, proxy, SQLite state, doctor,
Cloudflare sharing, plugins, Python client.
