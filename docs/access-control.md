# Access control

Every hosted app is reached through Rynk's **access gateway** on its share
port. That is what makes these controls real:

| Control | How |
| --- | --- |
| Maximum active users | popup, `--max-users 10`, `rynk limit 10`, `access.maxUsers` |
| Invite-only links | popup "Invite-only", `--protected`, `rynk share --invite` |
| See who's connected | popup live view, `rynk clients` |
| Disconnect / block | popup, `rynk clients disconnect <session> [--block]` |

## What counts as an active user

> **Active users = active Rynk client sessions.**

Rynk does not claim to detect individual human beings. Instead, it precisely tracks active client sessions:

```text
Browser / Client
       ↓
Rynk session cookie (__rynk_<port>)
       ↓
Multiple concurrent HTTP requests / assets / websockets
       ↓
ONE active session
```

A **session** is one browser (or client). The gateway gives it an HttpOnly
cookie, `__rynk_<port>`, scoped to that share port and removed before requests
reach your app. Clients that don't keep cookies (curl, some IoT devices) are
grouped by network address + user agent.

A session is **active** while it has made a request within the idle timeout
(default 60 s, `access.idleTimeout`) *or* holds an open connection —
WebSocket, Server-Sent Events or any streaming response. Loading one page with
fifty assets is one active user, not fifty. An inactive session becomes
**idle** (doesn't count) and is forgotten after 10 minutes.

When the limit is reached, a new or returning-idle visitor gets HTTP 503 with a
plain page: *"Access temporarily unavailable. The host has reached its
configured maximum number of active users."* People already active are never
cut off by a limit change; lowering the limit only affects newcomers.

## Invite-only links

```bash
rynk share --invite --expires 2h --uses 5
# http://192.168.1.42:5173/?rynk_access=Qm9…
```

An invite starts up to `--uses` new sessions until it expires or you revoke it
(`rynk share --revoke <id>`). On first use the token is exchanged for a
session cookie and removed from the address bar. Switching an app to
invite-only keeps everyone currently connected. Tokens are stored only as
hashes.

## Disconnecting and blocking

Disconnect ends the session immediately, closing its open connections; that
browser sees *"The host ended your session"* and can reconnect later (subject
to limits and invites). `--block` also refuses the client's address until
hosting stops (`rynk clients unblock <address>`).

## Addresses: what you see and don't

Rynk shows the address observed on the TCP connection. Devices behind NAT, a
VPN or a guest-network gateway may share one address, and visitors through a
public tunnel all appear as `127.0.0.1` — so sessions, not addresses, are the
unit Rynk counts, and blocking by address affects everyone behind it. Rynk
ignores `X-Forwarded-For` sent by visitors.

## Privacy and retention

Client addresses and user agents are kept in memory only, shown to the host
for active and idle sessions, forgotten 10 minutes after a session goes idle
(configurable: `access.clientRetention` in rynk.yaml or
`RYNK_CLIENT_RETENTION`), and discarded when hosting stops. Hosting-session
records keep only aggregate numbers (maximum and peak users), never addresses. Nothing about visitors is written to disk or
advertised to other Rynk nodes.

## Protection against abusive clients

Independently of the user limit, the gateway protects the host:

| Limit | Default |
| --- | --- |
| Requests per second per client address (sustained / burst) | 200 / 600 → HTTP 429 |
| Simultaneous requests per session | 64 → 429 |
| Open WebSockets per session | 32 → 429 |
| Open connections to the gateway in total | 2048 |
| Request body size (declared or streamed) | 256 MB → 413 |

Rynk's own reachability checks carry a per-gateway secret header and are
answered by the gateway directly, so they never count as visitors or reach
your app.

## Limits of the gateway

- Compose projects publish their own ports, so they are shared directly and
  these controls don't apply (Rynk warns).
- An app that ignores the loopback port Rynk assigns and listens on the LAN
  itself is also reachable directly, bypassing the gateway; Rynk warns when it
  detects this.
