# @rynk/cli

> **Run any project. Get a live link.**  
> Zero-config local network hosting, ngrok-style port forwarding, access control, and multi-laptop discovery.

---

## 🚀 Installation & Quick Start

Requires **Node.js 22.13+** (built-in SQLite; no native compile steps).

### One-Time Install Across Laptop (Recommended)
Installs the `rynk` command permanently in your terminal:
```bash
npm install -g @rynk/cli
```

### Zero-Install (Run instantly via npx)
```bash
npx @rynk/cli
npx @rynk/cli http 3000
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

# 4. Access control & visitor limits
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

GitHub Repository: https://github.com/charanbalaji2005/Rynk
