# Security details

This page expands on [SECURITY.md](../SECURITY.md).

## Daemon access

- Listens on `127.0.0.1:9876`. `RYNK_DAEMON_HOST` can change this; don't bind
  it to a LAN address unless you understand the consequences, and add the
  host to `RYNK_ALLOWED_HOSTS`.
- Token: 32 random bytes, regenerated on every daemon start, stored in
  `RYNK_HOME/daemon.json` with mode 0600. Compared in constant time.
- Every request's `Host` must be loopback (blocks DNS rebinding); browser
  `Origin` must match the host (blocks CSRF).
- There is no web dashboard. The popup window talks to the CLI over a stdio
  pipe and never receives the token.
- Rate limit: token bucket per client; request bodies capped at 1 MB; every
  input validated with Zod.

## Processes

- Detected commands run as argv arrays without a shell.
- Executables given as paths must be inside the project directory.
- Child processes get your environment minus Rynk's credentials.
- Python dependencies go into `.venv`, never the system interpreter.
- `rynk deploy <repo>` confirms before running a cloned repository.

## Data

- Logs are redacted before they are stored, streamed or shown.
- SQLite lives in `RYNK_HOME/data` (or `RYNK_DATA_DIR`), readable by your user.
- The proxy and static server refuse dotfiles, keys and database files.

## Secrets at rest

Env values you pass with `--env` or put in rynk.yaml are stored in the
database encrypted with AES-256-GCM under a random key in
`RYNK_HOME/secret.key` (owner-only). API responses replace secret-looking
values with `[REDACTED]`. The daemon token (`daemon.json`) and node private key
(`node.json`) are necessarily stored on disk, readable only by your user.

## Node identity

Node ids are derived from Ed25519 public keys and node descriptions are
signed, so discovery can't be used to impersonate another computer. See
[discovery.md](discovery.md).

## What the LAN can see

| Surface | Contents |
| --- | --- |
| Share port | Your app, behind the access gateway (no Rynk controls) |
| `:7780/rynk/v1/node` | Node name, platform, version, addresses, advertised app links |
| UDP 7779 / mDNS | Node id, name, revision, version |

## Visitors

See [access-control.md](access-control.md) for sessions, limits, invites,
disconnect/block and how client addresses are handled (memory only, never
persisted or advertised).

## Public links

Public links are created only by `rynk share --public`, `--public`, or choosing
"Public tunnel" in the popup, are labelled
"internet-visible", and are closed when the project stops or with
`rynk share --stop`. They expose only that project's port.
