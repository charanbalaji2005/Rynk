# The "Host this project" popup

Running `rynk` in a project opens one small window. It is not a website and
never needs a browser. It shows what Rynk detected and lets you change it
before anything starts:

- project name and folder; framework, runtime and package manager
- start command (edit to override), runtime (Auto, Docker, Static, Custom command)
- port (Auto or a number), host (Auto, 0.0.0.0, 127.0.0.1, an interface IP)
- network interface — Wi-Fi/Ethernet/VPN with their IPs, best one preselected
- exposure — Local only · LAN · Public tunnel (public shows a warning)
- max active users, invite-only, auto restart, health check, network discovery
- a live summary of the resulting share link

**Start Hosting** (or Enter) starts it; **Cancel** (or Esc) starts nothing.

After start the window becomes a compact live view: share link with Copy, QR
and Open; status, port, PID, uptime, active users; the connected clients with
Disconnect and Block; a limit you can change; Logs; Restart; Stop Hosting.
Closing the window never stops hosting — only Stop Hosting or Ctrl+C in the
terminal does.

## Which window you get

| Situation | Window |
| --- | --- |
| Python with Tk available (python.org installs on Windows/macOS; `python3-tk` on Linux) | Tk |
| Windows without Python | WinForms via the built-in PowerShell |
| No desktop session (SSH, headless), or neither toolkit | The same form in the terminal |

If a window fails to appear within a few seconds Rynk moves on to the next
option, so hosting is never blocked by the popup.

Environment: `RYNK_POPUP=off` (never), `terminal` (always the terminal form),
`tk` or `winforms` (prefer one).

## When it is skipped

Any explicit hosting flag (`--port`, `--lan`, `--cmd`, …), `--yes`,
`--non-interactive`, `--json`, `--no-popup`, a non-terminal stdin/stdout or
`CI=1`. `--popup` forces it.

## How it talks to Rynk

The window is a child process of the CLI and exchanges JSON lines over its own
stdin/stdout (`init`, `progress`, `live`, `status`, `qr`, `log` in;
`start`, `cancel`, `action`, `disconnect`, `limit`, `closed` out). It opens no
network sockets and never sees the daemon token; the CLI performs every action
through the local daemon API. The protocol is defined in
`packages/popup/src/protocol.ts`.
