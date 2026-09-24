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

## Everyday commands

| Command | |
| --- | --- |
| `rynk` | Host this folder (popup → live). Ctrl+C stops. |
| `rynk start` | Host in the background. |
| `rynk share` | Share link + QR code + users. `--invite`, `--public`, `--stop` |
| `rynk clients` | Who's connected. `rynk clients disconnect <session> [--block]` |
| `rynk limit 20` | Change the maximum number of active users (0 = unlimited). |
| `rynk apps` | Every app on every Rynk computer on this network. |
| `rynk nodes` | Rynk computers on this network. |
| `rynk status` · `logs -f` · `stop` · `restart` | Lifecycle. |
| `rynk hosting` | Hosting history: when each project was shared and peak users. |
| `rynk plan` · `inspect` · `ports` · `network` | See what Rynk will do / is doing. |
| `rynk network test` · `doctor` | Diagnose network, firewall and project problems. |

Common flags: `--local` `--lan` `--public` `--port` `--host` `--network`
`--cmd` `--runtime` `--max-users` `--protected` `--qr` `--yes`
`--non-interactive` `--json`. Full reference: [docs/cli.md](docs/cli.md).

### Examples

```bash
# Run with a custom start command
rynk --cmd "npm run dev:custom"
rynk start --cmd "python -m uvicorn main:app --port 8000"

# Host a specific project or subfolder
rynk start ./apps/dashboard
rynk start "C:\path\to\project" --cmd "pnpm dev"

# Target a running project by name from any folder
rynk status dashboard
rynk share dashboard
rynk logs dashboard -f
rynk stop dashboard

# CI / automation (no popup, accept defaults)
rynk start --lan --max-users 5 --non-interactive
rynk status --json
```

## Install

Requires **Node.js 22.13+** (Rynk uses Node's built-in SQLite; nothing native to compile).

```bash
npx rynk                    # no install
npm install -g rynk         # or pnpm add -g rynk / yarn global add rynk
pip install rynk            # Python: same `rynk` command, plus `from rynk import Rynk`
```

The popup uses Tk (bundled with Python on Windows and macOS; `sudo apt install
python3-tk` on Debian/Ubuntu) or, on Windows without Python, WinForms via the
built-in PowerShell. Without either — or over SSH — Rynk shows the same form
in the terminal.

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
