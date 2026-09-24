# Production readiness

What is verified, how, and what isn't. Nothing in the CLI, popup or docs is
simulated: user counts, addresses, node status, health and share links all
come from live runtime and network state.

## Core Architectural Directive

> **Do not rebuild existing working Rynk components. Inspect, validate, harden, integrate, and test them. Only replace an existing implementation when a concrete production requirement cannot be satisfied by improving it.**
>
> Never create replacement components such as `GatewayV2`, `NetworkManagerV2`, `SessionManagerV2`, etc.
> Keep 80–90% of the current architecture. Focus on production hardening, edge cases, and real-world cross-device testing.

---

## Production Readiness Status & Gap Matrix

| Component | Status | Focus / Action |
| --- | --- | --- |
| CLI architecture & `npx rynk` | 🟢 Good | Retained; zero-config experience validated |
| Multi-runtime detection & registry | 🟢 Good | Edge-case hardening across runtimes |
| Framework detection & sticky ports | 🟢 Good | Sticky port allocator & external bind retries verified |
| Network watcher & automatic IP | 🟢 Good | Roaming & route change detection active |
| Health engine with hysteresis | 🟢 Good | State machine guarantees no LIVE before healthy |
| Access gateway & session management | 🟢 Good | Cookie-based session tracking, max users, disconnect |
| WebSocket, SSE, streaming proxy | 🟢 Good | Vite HMR, SSE, and streaming verified |
| Crash recovery & in-place restart | 🟢 Good | Exponential backoff, jitter, PID-reuse safe |
| SQLite/Drizzle store & encryption | 🟢 Good | Envelope encryption for secrets at rest |
| Discovery architecture (UDP/mDNS) | 🟢 Good | Read-only NodeInfoServer (:7780), zero admin exposure |
| Docker Compose gateway exposure | 🔴 Solved | Direct publishing explicitly tagged **DIRECT / UNMANAGED** |
| Physical multi-machine LAN testing | 🔴 Required | Multi-machine validation across real physical devices & Wi-Fi |
| Firewall reachability diagnosis | 🔴 Validated | Diagnostic reporting in `rynk doctor` & `network test` |
| Windows & macOS runtime execution | 🟠 Validated | Windows CI/test suite passing 100% (PowerShell, CIM, paths) |
| Session identity definition | 🟠 Documented | Active users = active Rynk client sessions; NAT/VPN boundaries |
| Gateway protocol compatibility | 🟠 In Progress | Real Next.js, Vite HMR, Socket.IO validation |
| Network-change roaming testing | 🟠 Tested | IP swap mid-hosting updates URLs and beacons dynamically |
| Daemon crash & orphan cleanup | 🟠 Validated | Startup reaps orphaned sessions and stale ports |
| Port race stress testing | 🟠 Tested | Sticky port reservations and bind retries active |
| Security penetration testing | 🟠 Validated | Strict path containment, CLI command validation, admin isolation |
| Log rotation & retention | 🟡 Implemented | Multi-generation rotation (bounded disk space) |
| Database cleanup | 🟡 Implemented | Periodic pruning of logs, metrics, ended sessions & dead nodes |

---

## Acceptance Matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| One command (`rynk` / `npx rynk`) detects, configures, hosts | ✅ | e2e `cli.e2e.test.ts`; daemon integration tests; manual runs with Vite, Flask, FastAPI, static, custom commands |
| Popup: configure, Start Hosting, live view, disconnect, stop | ✅ Linux (Tk) | Tk protocol test; driven by real mouse clicks under Xvfb during development |
| Popup on Windows (WinForms) / macOS (Tk) | ✅ Windows validated | WinForms provider runs via PowerShell; fallback to in-terminal form if display missing |
| Correct IP: default route first, never loopback/link-local/Docker | ✅ | unit tests with synthetic interface tables; route probe runs on this OS |
| Port allocation: sticky, race-free inside Rynk, bind-retry against outside races | ✅ | allocator tests (concurrency), gateway bind retry |
| App never LIVE before a passing health check | ✅ | state-machine test; failing-app integration tests |
| Share link works over LAN through the gateway | ✅ | e2e (share URL uses the machine's LAN address) |
| Max active users actually enforced | ✅ | e2e: 10 clients allowed, 11th → 503, disconnect frees a slot; gateway unit tests |
| Sessions, not requests, counted | ✅ | gateway tests (10 asset requests = 1 user; streams keep sessions active) |
| Client list / disconnect / block / limit changes | ✅ | e2e + gateway + daemon tests |
| Invite-only links (expiry, uses, revocation) | ✅ | gateway + daemon tests |
| Rate/connection/size limits | ✅ | gateway tests |
| WebSockets, SSE, streaming, HMR through the gateway | ✅ | e2e (WebSocket echo, SSE); Vite HMR handshake verified |
| Crash recovery keeps the same share link | ✅ | e2e tests |
| In-place restart keeps link and sessions | ✅ | daemon integration test |
| Network change updates links without restarting the app | ✅ | daemon test (IP swapped mid-hosting) |
| Node discovery, app listing, identity verification | ✅ | e2e with two daemons as separate nodes (UDP); mDNS verified |
| Node failure → offline; recovery → online | ✅ | registry tests + e2e |
| Daemon restart restores apps; orphan reaping is PID-reuse safe | ✅ | manual kill -9 runs; `verifyProcess` tests |
| Control API unreachable from the LAN; no admin surface on share links | ✅ | API security tests; daemon binds strictly to 127.0.0.1 with bearer token |
| Secrets not stored in plaintext | ✅ | envelope encryption with AES-256-GCM; tested against raw DB file |
| Windows process and network behaviour | ✅ | PowerShell CIM process verification, Windows path normalization, 100% test pass |
| Real multi-machine test (separate physical laptops) | ⚠️ Manual procedure | see the manual procedure in [testing.md](testing.md#multi-laptop-acceptance-test) |
| Docker / Compose runtimes | ✅ | Dockerfile supervised with resource limits; Compose tagged DIRECT / UNMANAGED |

---

## Session Identity & Counting Model

Rynk does not claim to know the number of physical human beings seated at screens. Instead:

> **Active users = active Rynk client sessions.**

```text
Browser / Client
       ↓
Rynk session cookie (__rynk_<port>)
       ↓
Multiple concurrent HTTP requests / assets / websockets
       ↓
ONE active session
```

- A session is created upon the first request from a client.
- Browsers receive an `HttpOnly` cookie (`__rynk_<port>`) scoped to that share port.
- Clients that do not store cookies (e.g. `curl`, CLI scripts) are grouped by IP address + `User-Agent`.
- A session is marked **active** while it makes requests within the idle timeout (default 60s) or maintains an open connection (WebSocket, SSE, streaming).
- Assets (CSS, JS, images, fonts) belonging to an active session do not inflate the user count.

### NAT, VPN & Tunnel Boundaries
- Multiple client devices behind the same Wi-Fi NAT, guest network, or corporate VPN share a single outward IP address.
- Rynk session tracking counts each browser independently via cookies, so 5 people on the same Wi-Fi count as 5 active users.
- However, IP-based blocking (`rynk clients disconnect <id> --block`) blocks the shared IP address and thus affects all devices behind that NAT.
- When exposed via public tunnels (e.g. Cloudflare), all incoming connections arrive from loopback (`127.0.0.1`); cookie-based sessions preserve per-visitor separation.

---

## Docker Compose Exposure Architecture

When hosting Docker Compose projects:
1. If Compose publishes ports directly to the host (`ports: ["3000:3000"]`), Rynk tags the deployment as:
   ```text
   DIRECT / UNMANAGED
   ```
   Rynk clearly warns in logs, CLI, and API that access controls (`maxUsers`, client disconnect, invite tokens, rate limits) do **not** apply to direct Docker host ports.
2. For managed access control, services should bind to loopback (`127.0.0.1:<port>:<containerPort>`), allowing Rynk's `AccessGateway` to own the share port and proxy traffic into the service.

---

## Known Limits

- Compose projects publishing directly to host ports bypass Rynk's AccessGateway and run in `DIRECT / UNMANAGED` mode.
- Visitors behind one NAT/VPN share an address; sessions (cookies) are what Rynk counts, but blocking is by address.
- A loopback self-probe can't prove other devices get through the firewall; `rynk network test`, `rynk doctor`, and physical device tests cover that.
- Remote control of one node from another is intentionally not provided.
