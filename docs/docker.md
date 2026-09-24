# Docker

## Dockerfile projects

When a folder has a `Dockerfile` (and no native project, or you pass
`--runtime docker`), Rynk:

1. builds an image tagged `rynk/<name>:latest`,
2. picks the container port from `EXPOSE` (or `docker.containerPort`),
3. runs it in the foreground as a supervised process, publishing
   `127.0.0.1:<internal port> → container-port` (the access gateway provides
   the share port), and
4. health-checks it like any other app.

Containers run hardened by default:

```
--cap-drop ALL --cap-add CHOWN,DAC_OVERRIDE,FOWNER,SETGID,SETUID,NET_BIND_SERVICE,KILL
--security-opt no-new-privileges --pids-limit 512 --memory 2g --cpus 2
```

Environment variables are passed as `-e NAME` with values in the child
environment, so secrets never appear in the process list.

## Compose projects

With `compose.yaml` / `docker-compose.yml`, Rynk runs
`docker compose -p rynk-<name>-<id> up --build` and routes to the published port of
the web service (the first service publishing a port, or `docker.service`).

### Direct publishing (DIRECT / UNMANAGED)

When Compose files define public host ports (e.g. `ports: ["3000:3000"]`), Docker Engine binds directly to host interfaces. Rynk flags this as:

```text
DIRECT / UNMANAGED
```

Because traffic bypasses Rynk's `AccessGateway`:
- User limits (`maxUsers`) are not enforced.
- Invite tokens and client session tracking do not apply.
- Disconnecting or blocking visitors via `rynk clients` is unavailable.
- Rynk logs an explicit warning so access control is never claimed.

### Managed mode (Recommended for access control)

To use Rynk's access controls with Compose, bind the container port to loopback only (e.g. `ports: ["127.0.0.1:3000:3000"]`). Rynk will place the `AccessGateway` on the public share port:

```text
Client → Rynk Gateway → Docker Compose (127.0.0.1) → Container
```

## Requirements

Docker Desktop or Docker Engine with the `docker` CLI on your PATH, and the
engine running. `rynk doctor` checks both.
