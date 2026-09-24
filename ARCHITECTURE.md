# Architecture

Rynk is a CLI-first, local-first hosting tool. A long-lived **daemon** owns
running apps; the **CLI** is the interface; a small **native popup** is an
optional "Host this project" dialog the CLI shows. There is no web dashboard
and no cloud component.

```
                 ┌──────────── this computer ─────────────────────────────────┐
  you ──▶ rynk CLI ◀──JSON lines (stdin/stdout)──▶ popup window (Tk/WinForms) │
            │                                                                 │
            │ HTTP + WebSocket on 127.0.0.1:9876, Bearer token                │
            ▼                                                                 │
          daemon                                                              │
            ├─ DetectorRegistry → resolveProject (CLI > rynk.yaml > …)        │
            ├─ RuntimeRegistry (native · custom · static · docker · compose)  │
            ├─ DeploymentEngine (state machine) ── EventBus ──▶ WS clients    │
            │     app  ◀── 127.0.0.1:<internal port>                          │
            │     AccessGateway ── 0.0.0.0:<share port> ◀── visitors          │
            ├─ PortAllocator ×2 (share ports: sticky · internal: 41000+)      │
            ├─ HealthMonitor · NetworkWatcher · LogManager · Store (SQLite)   │
            ├─ NodeRegistry ── UDP beacons (7779) + mDNS/DNS-SD (5353)        │
            └─ NodeInfoServer (read-only, :7780) ◀── other Rynk nodes         │
                 └────────────────────────────────────────────────────────────┘
```

## Interfaces

**CLI** (`packages/cli`, published as `rynk`) — every feature is reachable
from the terminal, with `--json` for tools and `--non-interactive` for CI.

**Popup** (`packages/popup`) — shown by the CLI for a plain interactive
`rynk`/`rynk start`. Provider order: Tk (Python's built-in toolkit) → WinForms
(Windows PowerShell, no install) → an in-terminal form. The window is a child
process speaking JSON lines over its own stdin/stdout, so it never opens a
socket and never sees the daemon token; the CLI relays actions to the daemon.
A provider that fails to come up (no display, missing toolkit) is abandoned
after a ready-timeout and the next one is tried. See [docs/popup.md](docs/popup.md).

**Programmatic** — `import { Rynk } from "rynk"` and `from rynk import Rynk`
wrap the same daemon API. The Python package's `rynk` command is a launcher
for the Node CLI (global install, else `npx`), so behaviour is identical.

## Hosting pipeline

```
CREATED → DISCOVERING → RESOLVING → PREPARING → INSTALLING → BUILDING
        → ALLOCATING → STARTING → HEALTH_CHECKING → REGISTERING → EXPOSING → LIVE
LIVE → RESTARTING → STARTING …     any active state → STOPPING → STOPPED | FAILED
```

`assertTransition` enforces this; nothing may skip HEALTH_CHECKING, which is
what guarantees "never LIVE before healthy".

1. **Detect & resolve** — detectors score the folder; settings merge in the
   order CLI → popup choices → rynk.yaml → metadata → detector → defaults.
2. **Install/build** — streamed to logs; Python always gets a project venv.
3. **Start** — the app is told to listen on **127.0.0.1:<internal port>**
   (flags like `--host 127.0.0.1 --port N`, or `PORT`/`HOST`). Apps that pick
   their own port are found by probing and by parsing their output; ports owned
   by other projects, busy beforehand, or equal to our own share port are never
   adopted.
4. **Health check** — HTTP (or TCP/process) probes with backoff until healthy.
5. **Expose** — an `AccessGateway` binds the **share port** (framework default
   if free, sticky per project) on 0.0.0.0 (LAN), 127.0.0.1 (local) or one
   chosen interface, and proxies to the app. The share link is
   `http://<chosen interface IP>:<share port>`.
6. **Live** — a **hosting session** record is created (node, ports, URLs,
   exposure, access policy, peak users, status) and updated as health, network
   and limits change; health monitoring with hysteresis in both directions
   (failure threshold, success threshold, grace period); metrics every 5 s;
   node re-announcement.

### Why a gateway in front of every app

A share link that goes straight to the app can't enforce a user limit, can't
be invite-only, can't list or disconnect clients, and breaks while the app
restarts. The gateway makes all of that real, keeps the link stable across
restarts (clients see an auto-refreshing "restarting" page), and removes the
classic "app only listens on localhost" failure. It adds one loopback hop and
supports HTTP streaming, SSE and WebSocket upgrades (HMR works). Compose
projects publish their own ports, so they're shared directly without it.

### Sessions (what "3 / 10 users" means)

A **session** is bound to an HttpOnly cookie scoped to the share port
(`__rynk_<port>`, stripped before requests reach the app). Clients that don't
keep cookies are grouped by address + user agent. A session is **active**
while it has made a request within `idleTimeoutMs` (default 60 s) or holds an
open connection (WebSocket, SSE, streaming). Only active sessions count toward
the limit; page assets never inflate the count. Idle sessions are forgotten
after 10 minutes, and all session data is in memory only. See
[docs/access-control.md](docs/access-control.md).

### Restarts and recovery

- Requested restart (`rynk restart`, popup) is **in place**: same deployment,
  same share port, clients keep their sessions.
- Crash after LIVE → restart with exponential backoff and jitter; the attempt
  budget resets after 60 s of stability. Startup crashes fail immediately with
  the last output and hints.
- Daemon restart → deployments whose desired state is running are restored;
  orphaned processes from a killed daemon are reaped first (verified by
  process start time, so a reused PID is never killed).

## LAN discovery

Each daemon has a persistent, self-certifying **node id** — the hash of its
Ed25519 public key (`RYNK_HOME/node.json`, 0600) — never an IP. Node
descriptions are signed; the registry only lists nodes whose key matches their
id and whose signature verifies. Two providers run side by side and are merged
by node id:

- **UDP** — a ~150-byte beacon to 239.255.73.79:7779 every ~5 s on each LAN
  interface (TTL 1, never routed), a `query` for instant answers and a `bye`
  on shutdown. This is also the heartbeat.
- **mDNS / DNS-SD** — `_rynk._tcp.local` records (id, rev, version only),
  interoperable with Bonjour/Avahi/Windows mDNS.

Announcements carry a revision number; full details (apps, platform) are
fetched from the node's read-only `GET /rynk/v1/node` only when the revision
changes. Liveness: ONLINE (< 15 s since last beacon) → UNREACHABLE (< 60 s) →
OFFLINE; before demoting, the registry pings the node's info endpoint, so
networks that filter multicast still work once a node has been seen. There is
no node limit; traffic per node is constant and tiny. See
[docs/discovery.md](docs/discovery.md).

## Control vs. discovery (security boundary)

| Surface | Bind | Auth | Can change things? |
| --- | --- | --- | --- |
| Daemon API | 127.0.0.1:9876 | Bearer token + Host/Origin checks | Yes |
| Popup | stdin/stdout of a child process | inherited from CLI | Via the CLI only |
| App share port (gateway) | LAN/loopback | sessions, invites | No Rynk controls at all |
| Node info | 0.0.0.0:7780 | none (public, read-only) | No |
| Name proxy | 127.0.0.1:7777 | none (loopback) | No |

## Abuse protection at the gateway

Per-client token-bucket rate limiting, per-session caps on concurrent
requests and WebSockets, a global connection cap, and request-size limits
(declared and streamed). Rynk's own reachability probes carry a per-gateway
secret and are answered without creating a session.

## Persistence

SQLite (`node:sqlite` via Drizzle's sqlite-proxy driver, WAL) in
`RYNK_HOME/data/rynk.db`: projects, deployments (with the command and working
directory used for PID-reuse–safe reaping), hosting sessions, discovered nodes,
share-port mappings, routes, logs (with node/session/process metadata,
batched, retained per project), metrics, health history, events, settings.
Foreign keys are enforced; env values are encrypted at rest. Client sessions
and visitor addresses are deliberately *not* persisted.

## Design decisions

| Decision | Why |
| --- | --- |
| No web dashboard | The product is the CLI; a website adds attack surface, a build, and a second UI to maintain |
| Tk / WinForms popup instead of Electron/Tauri | Starts in ~200 ms, ~20 MB, nothing to download; Tauri would need per-OS native binaries shipped through npm and pip |
| Popup over a stdio pipe | No listening socket, no token in the window process |
| Gateway in front of apps | Makes limits, invites and client lists enforceable; stable links across restarts |
| Two discovery providers | mDNS is the standard; UDP beacons are simpler, faster and double as the heartbeat |
| `node:sqlite` | No compiler toolchain for `npx rynk` |
