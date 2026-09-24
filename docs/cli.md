# CLI reference

Every command accepts `--json` (machine-readable output) and `--verbose`.

## Hosting

| Command | |
| --- | --- |
| `rynk [dir]` | Host in the foreground. Shows the popup when run plainly in a terminal. Ctrl+C stops. |
| `rynk start [dir]` | Host in the background; the daemon keeps it running. |
| `rynk dev [dir]` | Same as `rynk`. |
| `rynk stop [project] [--all]` | Stop hosting. |
| `rynk restart [project]` | Restart in place: same link, clients keep their sessions. |
| `rynk deploy <path \| github:user/repo>` | Host a folder or a git repository (asks before running remote code; `-y` to skip). |

Hosting flags:

| Flag | |
| --- | --- |
| `--lan` / `--local` / `--public` | Who can reach it: your network (default), this computer, or also the internet (explicit opt-in). |
| `-p, --port <n>` | The port people connect to. Exact: fails if busy. Default: the framework's default or the next free one. |
| `--host <addr>` | Where to listen: `auto`, `0.0.0.0`, `127.0.0.1` or one interface's IP. |
| `--network <name\|ip>` | Which interface's IP goes in the share link. |
| `--cmd "<command>"` | Start command to use instead of the detected one. |
| `--runtime <kind>` | `auto`, `native`, `docker`, `compose`, `static`, `custom`. |
| `-n, --name <name>` | Project name. |
| `--max-users <n>` | Maximum active users (0 = unlimited). |
| `--protected` | Invite-only link. |
| `--no-advertise` | Don't announce to other Rynk nodes. |
| `--no-restart` · `--no-health-check` · `--no-install` | Opt out of crash restarts, HTTP probing, dependency install. |
| `-e KEY=value` | Extra environment variables (repeatable). |
| `--qr` | Print a QR code for the share link. |
| `-y, --yes` | Accept detected settings; no popup. |
| `--non-interactive` | No popup, no questions; host, print the link, exit (use in CI). |
| `--popup` / `--no-popup` | Force or suppress the popup. |

The popup appears only for a plain interactive `rynk` or `rynk start`: any
explicit hosting flag, `--yes`, `--json`, a pipe or `CI=1` skips it.

### Custom start commands and project targeting

```bash
# Run a project with a custom start command
rynk --cmd "npm run dev:custom"
rynk start --cmd "python -m uvicorn main:app --port 8000"

# Host a specific subfolder or project path
rynk start ./apps/dashboard
rynk start "C:\Projects\my-app" --cmd "pnpm dev" --network WiFi

# Inspect, share or view logs of a running project by name from anywhere
rynk status dashboard
rynk share dashboard
rynk logs dashboard -f
rynk stop dashboard
```

## Sharing and access

| Command | |
| --- | --- |
| `rynk share [project]` | Share link, QR code and active users. `--copy` copies it, `--open` opens it, `--no-qr`. |
| `rynk share --invite [--expires 2h] [--uses 5]` | Create an invite link (makes the app invite-only; current users keep access). |
| `rynk share --revoke <inviteId>` | Revoke an invite. |
| `rynk share --public [-y]` / `--stop` | Open / close a public tunnel. |
| `rynk clients [project]` | Connected clients: address, status, since, last seen, open connections, session id. |
| `rynk clients disconnect <session> [--block]` | End a session (and optionally block its address until hosting stops). |
| `rynk clients unblock <address> [--project p]` | Unblock. |
| `rynk limit <n> [project]` | Change the maximum active users (0 = unlimited). |

## Your network

| Command | |
| --- | --- |
| `rynk apps` | Apps shared by every Rynk node on this network. |
| `rynk nodes` | Rynk computers on this network, with status and last seen. |
| `rynk network` | Interfaces, the IP used for links, discovery status. |
| `rynk network test` | Checks IP, LAN binding, each app's port and share link, discovery and node communication. |
| `rynk ports` | Ports Rynk is using and what they're for. |

## Understanding

| Command | |
| --- | --- |
| `rynk plan [dir]` | What Rynk would do — framework, runtime, commands, IP, port, access. Nothing is started. |
| `rynk inspect [project]` | Everything about a hosted project. |
| `rynk status [project] [--all]` | Status, share link, users, resource use. |
| `rynk logs [project] [-f] [--tail n] [--since 2h]` | Logs (each line carries node, hosting-session and process ids in `--json`). |
| `rynk hosting [project] [--all]` | Hosting sessions: when a project was shared, peak users, how it ended. |
| `rynk doctor [dir]` | Runtimes, ports, firewall, discovery, project problems — with fixes. |
| `rynk projects` · `rynk remove` · `rynk routes` · `rynk runtime` · `rynk init` | Housekeeping. |
| `rynk daemon start\|stop\|restart\|status\|logs` | The background daemon. |

## JSON output

```bash
$ rynk status --json
{ "status": "live", "project": "my-app", "host": "192.168.1.42", "port": 5173,
  "url": "http://192.168.1.42:5173", "activeUsers": 3, "maxUsers": 10,
  "hostingSessionId": "hs_…", "uptimeMs": 754000, … }
```

`start --json`, `apps --json`, `nodes --json`, `network --json`,
`clients --json`, `plan --json` and the others return the same data the
commands print. Errors are `{ "ok": false, "error": { code, message, causes, suggestions } }`.
