# Runtimes and detection

A **detector** recognises a project; a **runtime adapter** runs it.

## Detected ecosystems

| Ecosystem | Recognised by | Start command (examples) | Port handling |
| --- | --- | --- | --- |
| Next.js, Nuxt, Remix, SvelteKit, Astro, Angular, Gatsby, CRA, Vite | `package.json` deps + scripts | `npm run dev -- --host 0.0.0.0 --port N` | flags or env, controllable |
| Express, Fastify, Koa, Hono, NestJS | deps | `npm run start` | `PORT` |
| Any Node app | `package.json` script `dev`/`start` | the script | `PORT`, discovered from output |
| Django | `manage.py` | `python manage.py runserver 0.0.0.0:N` | argument |
| FastAPI | `fastapi` dep + `app = FastAPI()` | `python -m uvicorn main:app --host … --port …` | arguments |
| Flask | `flask` dep | `python -m flask --app app run --host … --port …` | arguments |
| Streamlit, Gradio | deps | framework CLI | arguments / env |
| Go | `go.mod` | `go run .` | `PORT` |
| Rust | `Cargo.toml` | `cargo run` | `PORT` |
| Spring Boot, Quarkus | `pom.xml` / `build.gradle` | `./mvnw spring-boot:run` etc. | `SERVER_PORT` / `QUARKUS_HTTP_PORT` |
| Laravel, plain PHP | `artisan`, `composer.json`, `index.php` | `php artisan serve` / `php -S` | arguments |
| Rails, Rack | `Gemfile`, `config.ru` | `bin/rails server` / `rackup` | arguments |
| ASP.NET | `*.csproj` | `dotnet run` | `ASPNETCORE_URLS` |
| Deno | `deno.json` | `deno task start` | `PORT` |
| Procfile | `Procfile` `web:` line | the command (`$PORT` → port) | `PORT` |
| Docker / Compose | `Dockerfile`, `compose.yaml` | see [docker.md](docker.md) | published ports |
| Static site | `index.html` (also `dist/`, `build/`, `public/`) | built-in static server | argument |
| Make/CMake/Zig | build files | build only — you provide `start` | — |

Package managers are detected from lockfiles (npm, pnpm, yarn, bun). Python
tooling is detected in the order uv → poetry → pipenv → pip; with pip, Rynk
creates `.venv` and never installs into your system Python.

When two detectors match, the higher confidence wins and Rynk warns about the
ambiguity. Native detection beats Docker when both exist; pass
`--runtime docker` to prefer the container.

## Runtime adapters

| Runtime | Used for |
| --- | --- |
| `native` | Detected language toolchains |
| `custom` | Start commands you wrote (`--cmd`, `rynk.yaml start:`) |
| `static` | Hardened static file server with SPA fallback |
| `docker` | Single Dockerfile |
| `compose` | Docker Compose projects |

All adapters stream output, stop the whole process tree (process groups on
Unix, `taskkill /T` on Windows), and report CPU and memory.

## Port assignment

1. `--port` or `server.port` — used exactly, or fail with a clear error.
2. The framework default (5173, 3000, 8000…) if free.
3. The next free port above it, then any port in 3000–9999.

Ports are sticky per project, so bookmarks keep working. If an app ignores the
assigned port, Rynk notices where it actually listens (from its output or by
probing) and uses that instead.
