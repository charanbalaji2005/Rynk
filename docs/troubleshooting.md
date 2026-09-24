# Troubleshooting

Start with `rynk doctor` (runtimes, ports, firewall, discovery, project) and
`rynk network test` (IP → binding → each share link → discovery → other nodes).

## "Rynk couldn't work out how to start this project"

Nothing recognisable was found. Tell Rynk what to run:

```bash
rynk --cmd "python server.py" --port 8000
rynk init        # then edit rynk.yaml
```

## "… started but never answered on port N"

The process is running but nothing responds where Rynk is looking.

- The app uses a fixed port: `rynk --port 8080`.
- It's slow to boot (large JVM or first compile): raise `health.startupTimeout`.
- It isn't an HTTP server: set `health.type: tcp` or `process`.

## "… exited during startup"

Rynk shows the last lines of output and a hint. Typical causes: missing
dependencies (remove `node_modules`/`.venv` and retry), a syntax error, or a
missing environment variable. See everything with `rynk logs`.

## Port already in use

Rynk moves to the next free port automatically unless you asked for a specific
one. Find the culprit with `rynk projects` or `lsof -i :PORT` / `netstat -ano`.

## Other devices can't connect

1. Same network? Guest Wi-Fi and some office networks isolate clients.
2. Firewall: allow Node.js (macOS/Windows prompt) or `sudo ufw allow <port>/tcp`.
3. Windows: set the Wi-Fi network profile to **Private**.
4. VPN: disconnect, or use an address from your Wi-Fi adapter (`rynk status` lists all).
5. Check `rynk network test`: if the app answers on this computer but not over
   the LAN address, it's almost always a firewall.
6. The user limit may be reached — visitors then see "Access temporarily
   unavailable". `rynk clients`, `rynk limit <n>`.

## Other laptops don't show up in `rynk apps`

- Both computers must be on the same network and subnet, not a guest network.
- Allow UDP 7779 and 5353 and TCP 7780 (see [discovery.md](discovery.md)).
- `rynk network` shows whether UDP and mDNS started; `RYNK_DISCOVERY=udp` or
  `mdns` isolates one provider.

## The popup doesn't appear

- Linux: install Tk (`sudo apt install python3-tk`); you need a desktop session.
- Over SSH or in a container Rynk uses the terminal form instead.
- `RYNK_POPUP=terminal` forces the terminal form; `RYNK_POPUP=off` disables it.
- `rynk --verbose` prints why a window provider was skipped.

## The daemon won't start

```bash
rynk daemon logs
rynk daemon restart
```

If port 9876 is taken, set `RYNK_DAEMON_PORT`. If `daemon.json` is stale after
a crash, Rynk detects the dead PID and starts fresh.

## Resetting Rynk

```bash
rynk daemon stop
rm -rf ~/.rynk          # Windows: %LOCALAPPDATA%\Rynk
```

This forgets projects and logs; your project files are never touched.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RYNK_HOME` | State directory (default `~/.rynk`, `%LOCALAPPDATA%\Rynk` on Windows) |
| `RYNK_DATA_DIR` | Database directory (default `RYNK_HOME/data`) |
| `RYNK_DAEMON_PORT` / `RYNK_DAEMON_HOST` | Daemon API address |
| `RYNK_ALLOWED_HOSTS` | Extra Host names the API accepts |
| `RYNK_PROXY_PORT` / `RYNK_PROXY_HOST` | Name proxy address (default 127.0.0.1:7777) |
| `RYNK_PROXY=caddy`, `RYNK_CADDY_ADMIN` | Use Caddy as the proxy |
| `RYNK_PLUGINS` | Comma-separated global plugins |
| `RYNK_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |
| `RYNK_DAEMON_STDERR` | Also log the daemon to stderr |
| `RYNK_NODE_NAME` | How this computer appears in `rynk nodes` |
| `RYNK_DISCOVERY` | `all` (default), `udp`, `mdns` or `off` |
| `RYNK_DISCOVERY_PORT` / `RYNK_NODE_PORT` | Discovery UDP port (7779) / node info TCP port (7780) |
| `RYNK_APP_PORT_MIN` / `RYNK_APP_PORT_MAX` | Internal loopback port range (41000–41999) |
| `RYNK_POPUP` | `auto`, `tk`, `winforms`, `terminal`, `off` |
| `RYNK_CLIENT_RETENTION` | How long idle visitors are remembered (default `10m`) |
