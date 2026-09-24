# rynk (Python)

```bash
pip install rynk
cd my-flask-app
rynk
```

`pip install rynk` gives you the same `rynk` command as `npx rynk`: detection,
the "Host this project" popup, share links, user limits, `rynk apps`,
`rynk nodes` and everything else. The Python package is a thin launcher: it runs
the Node.js implementation (installed globally, or fetched with `npx` on first
use), so behaviour is identical everywhere. It needs **Node.js 22.13+**.

## Python API

```python
from rynk import Rynk

rynk = Rynk.connect()                      # starts the daemon if needed
app = rynk.host(".", max_users=10)         # waits until the app is healthy
print(app.url)                             # http://192.168.1.42:5000
for c in app.clients():
    print(c["clientAddress"], c["status"])
app.set_limit(20)
invite = app.invite(ttl_ms=3_600_000, max_uses=5)
print(invite["url"])
print([a["url"] for a in rynk.apps()])     # every app on the network
app.stop()
```

The API talks to the local daemon over `127.0.0.1` using the token in
`~/.rynk/daemon.json` (readable only by you). It has no dependencies.
