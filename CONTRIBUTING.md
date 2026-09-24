# Contributing to Rynk

Thanks for helping. Rynk aims to be boringly reliable, so changes come with
tests and friendly failure messages.

## Setup

```bash
corepack enable            # or: npm i -g pnpm@9
pnpm install
pnpm build
pnpm test
```

Run your working copy without touching a real install:

```bash
export RYNK_HOME=/tmp/rynk-dev     # isolates daemon.json, database and logs
export RYNK_DAEMON_PORT=19876       # avoids clashing with an installed daemon
export RYNK_NODE_NAME=dev-a         # how this node appears in `rynk nodes`
node packages/cli/dist/bin.js --help
```

`RYNK_DAEMON_STDERR=1` makes the daemon also log to stderr;
`node services/daemon/dist/main.js --foreground` runs it attached.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | Types, state machine, errors, command parsing, schemas |
| `packages/security` | Redaction, tokens, host/origin checks, command validation |
| `packages/config` | `rynk.yaml` schema, loading and precedence resolution |
| `packages/detector` | Detector registry and one file per ecosystem |
| `packages/runtime` | Runtime adapters |
| `packages/access` | Access gateway: sessions, user limits, invites |
| `packages/discovery` | Node identity, UDP + mDNS discovery, node registry, node info server |
| `packages/popup` | Native "Host this project" window (Tk, WinForms) + terminal fallback |
| `packages/ports`, `network`, `health`, `proxy`, `exposure` | Infrastructure |
| `packages/database` | SQLite schema and migrations |
| `packages/sdk` | Typed daemon client used by the CLI |
| `packages/cli` | The `rynk` command (published as `rynk`) |
| `services/daemon` | Engine, API server, bootstrap |
| `clients/python` | `pip install rynk`: launcher + Python API |
| `examples/` | Small projects for manual testing |

## Adding a detector

1. Add `packages/detector/src/detectors/<name>.ts` implementing `Detector`.
2. Register it in `BUILTIN_DETECTORS` (order does not matter; confidence ranks results).
3. Return evidence strings — users see them ("Detected Flask (requirements.txt…)").
4. Only inject port flags when you're sure the script invokes the framework binary.
5. Add fixtures to `packages/detector/test/detector.test.ts`.

## Rules of thumb

- Never mark something LIVE that hasn't passed a health check.
- Never run a shell unless the user wrote the command (`--cmd` or `rynk.yaml` with `shell: true`).
- Every thrown error is a `RynkError` with a message a beginner understands,
  likely causes and a suggested command.
- No new native dependencies; Rynk must `npx` cleanly on macOS, Linux and Windows.
- Keep idle cost near zero: unref'd timers, batched writes, no polling faster than needed.

## Commits and releases

Conventional commits (`feat:`, `fix:`, `docs:`…). Update `CHANGELOG.md` under
"Unreleased". Releases bump every package version together.

## Testing the popup

`pnpm test` runs the Tk window test when a display is available. Headless:

```bash
Xvfb :99 & DISPLAY=:99 pnpm test
RYNK_POPUP_AUTOSTART=500   # makes the window press "Start Hosting" by itself (tests only)
RYNK_POPUP=terminal        # force the in-terminal form
```

## Simulating several computers on one machine

Give each daemon its own home, ports and name; discovery works across them:

```bash
RYNK_HOME=/tmp/a RYNK_NODE_NAME=laptop-a rynk start
RYNK_HOME=/tmp/b RYNK_NODE_NAME=laptop-b RYNK_DAEMON_PORT=9877 RYNK_PROXY_PORT=7787 RYNK_NODE_PORT=7790 rynk start
rynk nodes
```
