# Testing

```bash
pnpm install && pnpm build
pnpm test            # everything: unit, integration, end-to-end (~40 s)
pnpm test:unit       # without the end-to-end suite
pnpm test:e2e        # only end-to-end (needs a prior build)
```

## Layers

| Layer | Where | What it proves |
| --- | --- | --- |
| Unit | `packages/*/test` | detection, config precedence, ports, network ranking, health hysteresis, gateway sessions/limits/invites/rate limits, discovery validation/TTL/signatures, secrets, process verification, migrations |
| Integration | `services/daemon/test` | the real daemon API with real child processes: deploy → health → gateway → LIVE, limits through the share port, invites, in-place and crash restarts, network change, hosting sessions, sealed env |
| End-to-end | `tests/e2e` | the built `rynk` binary against real daemons: `start --json`, 10 + 1 clients, disconnect, `limit`, SSE, WebSockets, crash recovery on the same link, `plan`/`inspect`, two daemons as two laptops discovering and verifying each other, a laptop leaving |
| Native window | `packages/popup/test` | the Tk popup speaks the protocol (runs only when a window can actually open) |
| Python | `clients/python/tests` | launcher and client |

Headless popup testing: `Xvfb :99 & DISPLAY=:99 pnpm test`.

## Multi-laptop acceptance test

Automated tests run several Rynk nodes on one machine. Before a release, run
this on real hardware (three laptops and a phone on one Wi-Fi):

1. **Laptop A:** in a Vite project, `npx rynk`. In the popup set *Max active
   users* to 2 and click **Start Hosting**. Note the share link.
2. **Laptop B:** open the link. On A, the popup and `rynk clients` show B's
   address as ACTIVE, `1 / 2`.
3. **Phone:** scan the QR code from A's popup. A shows `2 / 2`.
4. **Laptop C:** open the link → "Access temporarily unavailable".
5. **A:** disconnect the phone (popup or `rynk clients disconnect <id>`).
   C reloads → the app loads; A shows C.
6. **A:** edit a component → B and C hot-reload through the share link.
7. **A:** kill the dev server process (`kill <pid>` from `rynk status`).
   B's page shows "Restarting…" and recovers on the same link.
8. **Laptop B:** `npx rynk` in another project; on C run `rynk apps` → both
   A's and B's apps, each laptop `verified`.
9. **A:** switch Wi-Fi networks → the link and QR update; `rynk apps` on the
   other laptops shows A's new address within ~10 s.
10. **B:** `rynk daemon stop` → A and C show laptop-b OFFLINE.
11. Repeat 1–4 with A on Windows and on macOS.

Record OS versions, results and anything surprising in the release notes.
