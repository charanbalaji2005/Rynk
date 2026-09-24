# Security Policy

## Reporting a vulnerability

Email security@rynk.dev or open a private GitHub security advisory. We aim to
acknowledge within 72 hours. Please don't open public issues for vulnerabilities.

## Threat model

Rynk runs your code on your machine and shares it on your network. We defend:
**no one else can control Rynk**, **apps and secrets are only exposed as you
chose**, and **nothing reaches the internet unless you ask**.

| Threat | Defence |
| --- | --- |
| A web page or LAN device controls Rynk | The control API listens on 127.0.0.1 only, needs a 256-bit token (0600 `daemon.json`), checks Host (DNS rebinding) and Origin (CSRF). There is no web dashboard. |
| Control through a hosted app's link | The access gateway has no control endpoints. Stop/restart/logs/config exist only on the loopback API. |
| Control through discovery | Other nodes can read a public description (`GET /rynk/v1/node`: name, platform, advertised app links). Nothing else is served; nothing can be changed. |
| Spoofed discovery / node impersonation | Node ids are hashes of Ed25519 public keys; descriptions are signed and time-stamped; mismatches are ignored. Strict validation and size caps on all wire data. |
| One visitor exhausting the host | Per-client rate limits, per-session concurrency and WebSocket caps, a global connection cap and request-size limits at the gateway. |
| More visitors than intended | Max active users is enforced by the gateway; invite-only mode requires a single- or limited-use, expiring, revocable invite. |
| Leaking the invite token | Tokens are hashed at rest, swapped for a session cookie on first use and removed from the address bar by redirect. |
| Session hijack between apps | Session cookies are HttpOnly, SameSite=Lax, port-scoped, and never forwarded to the app. |
| Accidental internet exposure | LAN by default; public tunnels need `--public` or an explicit popup choice, are labelled internet-visible and still go through the gateway. |
| Secrets in the database | `--env`/rynk.yaml env values are AES-256-GCM encrypted at rest; API responses redact them. |
| Secrets in logs | Every line is redacted (API keys, JWTs, private keys, URL passwords, `*_SECRET=`) plus literal values of sensitive env vars. |
| Secret files | Gateway, name proxy and static server refuse `.env*`, `.git`, keys, `*.pem`, databases and similar. |
| App steals the daemon token | Rynk credentials are stripped from child environments. |
| Command injection | Detected commands run without a shell; shell syntax only for commands you wrote with `shell: true`. Executables must be inside the project. |
| Untrusted repositories | `rynk deploy <git-url>` asks before running a cloned repo. |
| Firewall tampering | Rynk never changes firewall settings; it only explains what to allow. |

## Privacy of client addresses

The host sees client network addresses (as observed on the TCP connection) for
**active and idle sessions only**. They are kept in memory, never written to
disk, forgotten 10 minutes after a session goes idle, and discarded when
hosting stops. Behind NAT, a VPN or a public tunnel the observed address is the
last hop, not the original device; Rynk ignores `X-Forwarded-For` from visitors.

## Not in scope

Code you choose to run (Rynk is not a sandbox; use `--runtime docker` for
untrusted code), people on your network opening a link you shared, and a
compromised account on the same machine.

More: [docs/security.md](docs/security.md) · [docs/access-control.md](docs/access-control.md)
