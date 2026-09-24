# rynk.yaml reference

Everything is optional. Missing fields are filled by detection. Unknown keys
are rejected with an explanation (typos never silently do nothing).
Accepted file names: `rynk.yaml`, `rynk.yml`, `.rynk.yaml`.

```yaml
name: shop                      # used in URLs; defaults to package name or folder

runtime: auto                   # auto | native | custom | static | docker | compose
                                # also accepted: runtime: { type: docker }

install: npm ci                 # string, or { command: "..." }
build: npm run build
start: node dist/server.js
shell: false                    # true allows &&, |, $VAR in the commands above

server:
  host: 0.0.0.0                 # 127.0.0.1 in local mode
  port: auto                    # the port people connect to; an explicit port fails if busy

health:
  type: http                    # http | tcp | process | command | none
  path: /healthz
  command: ./check.sh           # for type: command
  interval: 10s
  timeout: 3s
  startupTimeout: 2m            # how long to wait for the first healthy answer

network:
  exposure: lan                 # local | lan | public

restart:
  policy: on-failure            # never | on-failure | always
  maxRetries: 5

env:
  NODE_ENV: development
  FEATURE_FLAG: true            # numbers/booleans become strings

static:
  dir: dist                     # serve this folder with the static runtime

docker:
  dockerfile: docker/Dockerfile
  compose: compose.dev.yaml
  service: web                  # compose service to route to
  containerPort: 8080

access:
  maxUsers: 10                  # max active users; 0 = unlimited
  mode: open                    # open | protected (invite-only)
  idleTimeout: 60s              # when an inactive visitor stops counting
  clientRetention: 10m          # when an idle visitor's address is forgotten
  advertise: true               # list this app for other Rynk nodes

plugins:
  - "@acme/rynk-detector-elixir"
  - ./tools/rynk-plugin.mjs
```

## Placeholders

`{port}` and `{host}` in `start` are replaced with the assigned values.
`PORT` and `HOST` are always set in the environment too.

## Precedence

```
CLI flags  >  rynk.yaml  >  project metadata  >  detector  >  defaults
```

`rynk status --json` shows the merged definition and, under `source`, which
layers contributed.

## Shell commands

Commands run without a shell by default, so `&&`, pipes and variable expansion
are rejected with a hint. Set `shell: true` to opt in for commands written in
this file; detected commands never use a shell.
