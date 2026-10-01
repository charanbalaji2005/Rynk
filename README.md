# Rynk

**Run any project. Get a live link.**

Rynk automatically configures, hosts and shares applications directly from
your machine, with secure LAN discovery, access control, client limits and
multi-laptop networking — through a lightweight CLI and a small native window.

```bash
cd my-project
npx rynk              # or: pip install rynk && rynk
```

A small native window opens with everything already worked out:

```
┌──────────────────────────────────────────┐
│ Host with Rynk                  ● Ready  │
│ my-vite-app                              │
│ Vite · Node.js · pnpm                    │
│                                          │
│ Port         Auto (5173)                 │
│ Network      ● Wi-Fi   192.168.1.42      │
│ Exposure     ● LAN                       │
│ Max users    10                          │
│ ☐ Invite-only  ☑ Auto restart  ☑ Health  │
│                                          │
│            [ Cancel ]  [ Start Hosting ] │
└──────────────────────────────────────────┘
```

Click **Start Hosting** and you get a link anyone on your Wi-Fi can open —
laptops, phones, tablets, no install needed on their side:

```
╭─ RYNK HOSTING ─────────────────────────────╮
│ ● LIVE  my-vite-app                         │
│                                             │
│ Share:   http://192.168.1.42:5173           │
│ Local:   http://localhost:5173              │
│                                             │
│ Status:  HEALTHY   port 5173   pid 12482    │
│ Users:   0 / 10                             │
╰─────────────────────────────────────────────╯
→ 192.168.1.51 connected (1/10 active)
```

The window turns into a compact live view: copy link, QR code, who's
connected, disconnect, change the limit, logs, restart, stop.

**No website, no account, no cloud.** Rynk is a CLI plus that one small
window. Everything also works without the window (`rynk --yes`,
`--non-interactive`, `--json`).

## What it does for you

- **Detects the project** — Vite, Next.js, Nuxt, SvelteKit, Astro, Angular,
  Express, NestJS, Django, FastAPI, Flask, Streamlit, Go, Rust, Spring Boot,
  Laravel, Rails, ASP.NET, Deno, Docker/Compose, plain HTML and more — and
  its package manager, install/build/start commands and port.
- **Picks the address and port** — the right Wi-Fi/Ethernet IP (not Docker or
  VPN adapters), a free port near the framework's default, kept stable across
  restarts. When you change networks the link updates by itself.
- **Only says LIVE when it's true** — after the app answers a health check.
- **Controls access** — every visitor goes through Rynk's access gateway, so
  *max active users*, *invite-only links*, the client list and *disconnect*
  are enforced, not cosmetic.
- **Finds other Rynk computers** — on the same network, `rynk apps` lists every
  app every laptop is sharing, automatically (mDNS/DNS-SD + UDP). Node
  identities are cryptographically verified, and there's no limit on the
  number of computers.
- **Protects the host** — per-client rate limits, connection and size limits,
  secrets encrypted at rest, and no control surface on the network.
- **Keeps things running** — crash restarts with backoff, in-place restarts
  that keep the link and sessions, and apps restored after a reboot.

## 🚀 Installation & Quick Start

Requires **Node.js 22.13+** (uses Node's built-in SQLite; zero native build steps).

### One-Time Install Across Laptop (Recommended)
Installs the `rynk` command permanently on your laptop:
```bash
npm install -g @rynk/cli
# or: pnpm add -g @rynk/cli / yarn global add @rynk/cli
```

### Zero-Install (Run instantly via npx)
```bash
npx @rynk/cli
```

### Per-Project (Installed only in `node_modules`)
```bash
npm install --save-dev @rynk/cli
```

---

## ⚡ Quick Examples

```bash
# 1. Forward any running port (like ngrok)
rynk http 3000
rynk 3000
rynk http 8080 --public              # with public internet link

# 2. Zero-config auto-detect & host current directory
cd my-app
rynk                                 # foreground with live popup
rynk start                           # background daemon

# 3. Custom commands & runtimes
rynk --cmd "npm run dev:custom"
rynk start --cmd "python -m uvicorn main:app --port 8000"

# 4. Access control & invites
rynk share --invite                  # create single-use invite link
rynk limit 5                         # allow max 5 concurrent users
rynk clients                         # see connected devices & IP addresses
rynk clients disconnect <id> --block # disconnect and block user

# 5. Multi-laptop team discovery (LAN)
rynk apps                            # list every app shared on your Wi-Fi
rynk nodes                           # list all peer laptops on the network
```

---

## 📖 Command Reference

### 🌐 Hosting & Forwarding

| Command | Description |
| :--- | :--- |
| `rynk` | Host current directory with auto-detected stack and popup. `Ctrl+C` stops. |
| `rynk http <port>` | Forward an existing local port to the LAN/Internet like ngrok (e.g. `rynk http 3000`). |
| `rynk <port>` | Shortcut to forward a port (e.g. `rynk 3000` or `rynk :8080`). |
| `rynk start [dir]` | Host in the background (supervised by the Rynk daemon across crashes/reboots). |
| `rynk dev [dir]` | Host in foreground mode with live console logs. |
| `rynk stop [project]` | Stop hosting the target project (or current folder). |
| `rynk stop --all` | Stop all active hostings. |
| `rynk restart [project]` | Restart the application in place (preserves share link and client sessions). |

### 🔒 Access Control & Sharing

| Command | Description |
| :--- | :--- |
| `rynk share [project]` | Display share URL, QR code, active visitors, and settings. |
| `rynk share --invite` | Create a single-use invite token (switches app to invite-only mode). |
| `rynk share --public` | Expose the app to the public internet via secure tunnel. |
| `rynk share --stop` | Disable the public internet link (reverts to LAN only). |
| `rynk limit <n>` | Set the maximum allowed active users on the fly (`0` = unlimited). |
| `rynk clients` | View all active client sessions, IP addresses, and user agents. |
| `rynk clients disconnect <id>` | Disconnect a specific client session. |
| `rynk clients disconnect <id> --block` | Disconnect and ban client IP address from reconnecting. |

### 📡 Multi-Laptop LAN Discovery

| Command | Description |
| :--- | :--- |
| `rynk apps` | List every application shared by any Rynk laptop on the same Wi-Fi. |
| `rynk nodes` | List verified Rynk peer machines discovered via mDNS/UDP beacons. |
| `rynk hosting` | View historical hosting sessions, active durations, and peak users. |

### 🛠️ Diagnostics, Ports & Health

| Command | Description |
| :--- | :--- |
| `rynk status [project]` | Check health status, ports, PID, and live URLs. |
| `rynk logs [project] -f` | Tail unified deployment logs in real time. |
| `rynk plan [dir]` | Dry-run detector and show full configuration plan without side effects. |
| `rynk inspect [project]` | Deep diagnostic inspection of running deployment state and config. |
| `rynk ports` | List all allocated and active ports across host projects. |
| `rynk network` | List network interfaces, default IP, and detected subnets. |
| `rynk network test` | Run comprehensive end-to-end reachability diagnostics across firewall/LAN. |
| `rynk doctor` | Diagnose system dependencies, Node/Python runtimes, port conflicts, and firewall. |

---

### ⚙️ Options & Flags

| Flag | Description |
| :--- | :--- |
| `--lan` | Share on the local Wi-Fi/Ethernet network (default). |
| `--local` | Keep host bound to loopback `127.0.0.1` only. |
| `--public` | Create an internet-accessible link alongside LAN link. |
| `-p, --port <port>` | Specify the share port people connect to (default: auto). |
| `--host <host>` | Bind host address (`0.0.0.0`, `127.0.0.1`, or interface IP). |
| `--network <name\|ip>` | Target network interface (e.g. `wlan0`, `Wi-Fi`, `eth0`). |
| `--cmd "<command>"` | Custom start command (bypasses auto-detected command). |
| `--max-users <n>` | Cap simultaneous active visitor sessions. |
| `--protected` | Require invite tokens for all incoming visitors. |
| `--qr` / `--no-qr` | Print or suppress QR code in terminal. |
| `-y, --yes` | Accept detected configuration without showing popup window. |
| `--non-interactive` | Headless execution for CI/CD and automation scripts. |
| `--json` | Output machine-readable JSON for scripting. |

Full documentation: [docs/cli.md](docs/cli.md).

## Programmatic API

```ts
import { Rynk } from "rynk";
const rynk = await Rynk.connect();
const app = await rynk.host("./my-app", { maxUsers: 10 });
console.log(app.url);                 // http://192.168.1.42:5173
console.log(await app.clients());
```

```python
from rynk import Rynk
app = Rynk.connect().host(".", max_users=10)
print(app.url)
```

## How it works

```
 rynk CLI ──┬── native popup (Tk / WinForms, JSON over a pipe)
            └── local daemon API (127.0.0.1, token) ───────────────┐
                                                                    │
 daemon ─ detect → plan → install/build → start app on 127.0.0.1:<internal>
        ─ health check → access gateway on <LAN IP>:<share port> → LIVE
        ─ node discovery (mDNS + UDP) · read-only node info · SQLite state
                                                                    │
 visitors ─────▶ http://192.168.1.42:5173 ─▶ gateway (limits, invites, sessions) ─▶ app
 other laptops ─ discover each other, list each other's apps (never control)
```

Details: [ARCHITECTURE.md](ARCHITECTURE.md) · threat model: [SECURITY.md](SECURITY.md).

## Documentation

[Getting started](docs/getting-started.md) · [Full-stack guide (DB + API + Web)](docs/fullstack-guide.md) ·
[CLI reference](docs/cli.md) · [The popup](docs/popup.md) ·
[Access control](docs/access-control.md) · [Discovery](docs/discovery.md) ·
[Networking](docs/networking.md) · [Runtimes](docs/runtimes.md) ·
[rynk.yaml](docs/rynk-yaml.md) · [Docker](docs/docker.md) ·
[Public sharing](docs/public-sharing.md) · [Plugins](docs/plugins.md) ·
[Security](docs/security.md) · [Troubleshooting](docs/troubleshooting.md) ·
[Testing](docs/testing.md) · [Production readiness](docs/production-readiness.md)

## Development

```bash
pnpm install && pnpm build && pnpm test
node packages/cli/dist/bin.js --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
