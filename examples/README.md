# Examples

Each folder is a tiny project you can host with one command:

```bash
cd examples/vite-app && npx rynk
```

| Folder | What it shows |
| --- | --- |
| `node-http` | Plain Node server honouring `PORT`/`HOST` |
| `vite-app` | Vite dev server; Rynk adds `--host 0.0.0.0 --port … --strictPort` |
| `python-flask` | Flask in an automatically created `.venv` |
| `python-fastapi` | FastAPI via uvicorn with `/health` |
| `static-site` | Plain HTML served by Rynk's hardened static server |
| `docker-app` | `Dockerfile` project (`rynk --runtime docker`) |
| `compose-app` | Docker Compose; the published port is used as-is |
| `custom-command` | Undetectable project started from `rynk.yaml` |
| `go-http` | `go run .` with `PORT` |
