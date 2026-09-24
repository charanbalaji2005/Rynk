# CLAUDE.md — Rynk Development Guidelines & Production Checklist

## Core Directive

> **Do not rebuild existing working Rynk components. Inspect, validate, harden, integrate, and test them. Only replace an existing implementation when a concrete production requirement cannot be satisfied by improving it.**
>
> **Do not create replacements such as `GatewayV2`, `NetworkManagerV2`, `SessionManagerV2`, etc.**
> **Keep roughly 80–90% of the current architecture.** The repository already contains the core pieces. Focus on production hardening, edge-case resilience, and real-world validation.

---

## Production Status & Hardening Checklist

### 🟢 Retained Core Architecture (Keep & Harden)
- CLI architecture & `npx rynk` zero-config workflow
- Multi-runtime detection (Node, Python, Go, Rust, Java, PHP, Ruby, .NET, Deno, Docker, Compose, Procfile, Static)
- Framework detection & port allocator (sticky allocation per project)
- Automatic IP detection & network watcher
- Health engine with hysteresis (failure threshold, success threshold, grace period)
- Access gateway with session management, max-user enforcement & client disconnect
- WebSocket, SSE, HTTP streaming proxying & Vite HMR support
- In-place restart & crash recovery
- Background daemon with SQLite/Drizzle store
- Node identity & LAN discovery architecture (UDP beacons + mDNS)
- CLI JSON output & logging architecture

---

### 🔴 Must Correct Before Production

1. **Docker Compose Gateway Bypass**
   - Make Rynk-owned gateway exposure the default for Compose services:
     `Client → Rynk Gateway → Docker/Compose service`
   - If direct Docker port publishing remains enabled, explicitly tag and report it as `DIRECT / UNMANAGED`.
   - Never claim Rynk access controls (max users, client tracking, disconnect, invite tokens, rate limits) apply to unmanaged direct ports.

2. **Real Physical Multi-Machine Testing**
   - Validate LAN hosting across physical devices over real Wi-Fi networks (Laptop A ↔ Laptop B ↔ Mobile phones).
   - Test matrices: Windows ↔ Windows, Windows ↔ Linux, macOS ↔ Windows/Linux, Phone ↔ Rynk host.

3. **Firewall Testing & Diagnostics**
   - Verify full reachability path: `localhost → Rynk Gateway → OS Firewall → LAN → Remote Device`.
   - Test private vs. public network profiles, blocked ports, and allowed ports.
   - Ensure Rynk accurately diagnoses firewall blocks (`rynk doctor` / `rynk network test`) without silently altering OS firewall rules.

---

### 🟠 Critical Platform & Protocol Hardening

4. **Actual Windows and macOS Validation**
   - Run complete test suite and manual verification on Windows, Linux, and macOS.
   - Verify process trees, process termination (`taskkill` vs `kill`), signals, network interface enumeration, IPC, Tk/WinForms popup fallbacks, and daemon lifecycle.

5. **Session Identity Documentation**
   - Explicitly define: **Active users = active Rynk client sessions** (tracked via `__rynk_<port>` HttpOnly cookie; fallback to IP + User-Agent).
   - Document NAT/VPN behavior (clients behind the same NAT/VPN share an IP address; sessions are counted per browser, but IP blocking affects the shared IP).

6. **Gateway Protocol Compatibility**
   - Validate against real frameworks: Vite HMR, Next.js (Fast Refresh / Turbopack), WebSockets, Socket.IO, Server-Sent Events (SSE), streaming responses, large file uploads, cookies, redirects, and OAuth flows.

7. **Network-Change Testing**
   - Verify dynamic roaming: Wi-Fi network switch, Wi-Fi ↔ Ethernet, Wi-Fi ↔ VPN.
   - Ensure NetworkWatcher detects interface/IP shifts, updates share URLs, updates node discovery beacons, popup UI, and CLI output without restarting the target application.

8. **Daemon Crash & Recovery Testing**
   - Verify unexpected daemon crash recovery (`kill -9` or task termination).
   - On restart, restore database state, recover active hosting sessions, reattach or clean up orphaned processes safely without PID reuse issues, and purge stale state.

9. **Port Race Testing**
   - Concurrently launch multiple projects (e.g. 10–20 projects).
   - Ensure sticky allocation, zero port collisions, no unrelated process termination, and proper backoff/retry against external port binds.

10. **Security Penetration Testing**
    - Audit against path traversal, command/shell injection in project names or start commands, `.env` / `.git` leakage, and token replay/expiry.
    - **Crucial boundary**: LAN clients must NEVER be able to reach or interact with the daemon admin API (HTTP/WS on localhost:9876). The admin surface must be strictly bound to loopback with bearer token validation.

---

### 🟡 Production Polish & Operational Health

11. **Installation Experience**
    - Clean machine verification: `npx rynk`, `npm install -g rynk`, `pip install rynk`.
    - Provide actionable setup instructions when Node, Python, Docker, or package managers are absent.

12. **First-Run Experience**
    - Zero-friction launch flow: detect project → detect runtime → allocate port → detect IP → launch gateway and popup.

13. **Actionable `rynk doctor`**
    - Replace generic errors with contextual diagnosis, root causes, and remediation commands.

14. **Comprehensive `rynk network test`**
    - Diagnose interface, IP, default route, port binding, local connectivity, and LAN reachability.

15. **Resource Protection & DoS Resistance**
    - Enforce connection caps, payload size limits, idle timeouts, and backpressure for WebSocket/SSE proxies.

16. **Log Rotation & Retention**
    - Implement log size limits, retention windows, and automatic rotation to prevent unbounded disk usage.

17. **Database Cleanup**
    - Automatically prune expired sessions, old health metrics, stale logs, and offline node records in SQLite.

18. **Node Discovery Security**
    - Treat LAN discovery as discovery, not implicit administrative trust. Discovery beacons must not grant admin privileges.

19. **Versioning & Database Migrations**
    - Provide reliable schema migrations for `@rynk/database` with rollback capabilities across releases.

20. **Release Engineering**
    - Multi-platform packaging, checksum generation, changelog automation, and release verification.

---

## Architecture Quick Reference

```text
                 ┌──────────── host machine ───────────────────────────────────┐
  user ──▶ rynk CLI ◀──JSON lines (stdin/stdout)──▶ popup window (Tk/WinForms)  │
             │                                                                  │
             │ HTTP + WebSocket on 127.0.0.1:9876, Bearer token                 │
             ▼                                                                  │
           daemon                                                               │
             ├─ DetectorRegistry → resolveProject (CLI > rynk.yaml > …)         │
             ├─ RuntimeRegistry (native · custom · static · docker · compose)   │
             ├─ DeploymentEngine (state machine) ── EventBus ──▶ WS clients     │
             │     app  ◀── 127.0.0.1:<internal port>                           │
             │     AccessGateway ── 0.0.0.0:<share port> ◀── LAN visitors       │
             ├─ PortAllocator ×2 (share ports: sticky · internal: 41000+)       │
             ├─ HealthMonitor · NetworkWatcher · LogManager · Store (SQLite)    │
             ├─ NodeRegistry ── UDP beacons (7779) + mDNS/DNS-SD (5353)         │
             └─ NodeInfoServer (read-only, :7780) ◀── other Rynk nodes          │
                  └─────────────────────────────────────────────────────────────┘
```

## Build, Test & Development Commands

```bash
# Install dependencies
pnpm install

# Build all packages via Turbo & tsc -b
pnpm build

# Run unit tests
pnpm test:unit

# Run full e2e test suite
pnpm test:e2e

# Typecheck the entire monorepo
pnpm typecheck

# Lint codebase
pnpm lint

# Run CLI directly
node packages/cli/dist/bin.js <command>
# or
pnpm rynk <command>
```
