# Full-Stack Setup Guide (Database + Backend + Frontend)

This guide explains how to host full-stack projects (such as monorepos with PostgreSQL, Redis, backend APIs, and Next.js/Vite frontends) so that **everything runs together persistently in the background without exiting**.

---

## 1. Foreground vs. Background Hosting

Rynk supports two modes:

| Mode | Command | Behavior |
| :--- | :--- | :--- |
| **Foreground** | `rynk` or `rynk dev` | Runs inside your active terminal window. Pressing <kbd>Ctrl+C</kbd> or closing the terminal terminates the application. |
| **Background (Daemon)** | **`rynk start`** | Runs as a managed background service via the Rynk Daemon. **Does not exit** when you close your PowerShell/terminal window. Automatically restarts if a process crashes. |

---

## 2. Step-by-Step Full-Stack Setup

A full-stack application typically has three tiers:
1. **Database Layer** (e.g., PostgreSQL, Redis, MinIO in Docker)
2. **Backend API** (e.g., Fastify, Express, Django, FastAPI)
3. **Frontend UI** (e.g., Next.js, Vite, React, Vue)

---

### Step 1: Start the Database Layer

For databases running in Docker or Docker Compose, start them in detached mode:

```powershell
# From your project root or docker folder:
docker compose up -d
```

Verify that the database containers are healthy:
```powershell
docker compose ps
```

---

### Step 2: Configure LAN Networking & CORS

When sharing full-stack apps over Wi-Fi, remember the **LAN Client Rule**:
> When a phone or remote laptop visits `http://10.7.204.232:3000`, its browser executes client-side JavaScript. If your frontend calls `http://localhost:4000`, the phone will try to reach port 4000 on the *phone itself* and fail.

To ensure clients on Wi-Fi can reach the API:
1. **Frontend API URL**: Set your client API base URL to your machine's Wi-Fi IP (or use Next.js / Vite reverse proxy rewrites):
   ```env
   NEXT_PUBLIC_API_URL=http://10.7.204.232:4000
   ```
2. **Backend CORS**: Configure your backend API to allow connections from your LAN IP:
   ```ts
   // Example Fastify / Express CORS configuration
   cors({
     origin: [
       "http://localhost:3000",
       "http://10.7.204.232:3000",
       /^http:\/\/10\.7\.204\.\d+:3000$/
     ],
     credentials: true
   });
   ```

---

### Step 3: Launch Services in the Background with Rynk

Use `rynk start` with `--name` to host the backend and frontend independently as persistent background services:

#### 1. Start the Backend API:
```powershell
rynk start "C:\path\to\project\services\api" --name myapp-api --port 4000 --network WiFi
```

#### 2. Start the Frontend Web App:
```powershell
rynk start "C:\path\to\project\apps\dashboard" --name myapp-web --port 3000 --network WiFi
```

Both services will be kept alive and monitored by the Rynk daemon.

---

## 3. Alternative: Single Monorepo Setup with `rynk.yaml`

If you prefer launching your entire monorepo with a single command (e.g., `pnpm dev` or `turbo run dev`), create a `rynk.yaml` file in your project root:

```yaml
name: kairosdb-fullstack

# Keep running persistently and restart if any worker crashes
restart:
  policy: always
  maxRetries: 10

# Extend startup timeout so large TypeScript/Next.js compilations do not time out
health:
  type: http
  path: /
  startupTimeout: 3m
  interval: 10s
  timeout: 5s

# Share over Wi-Fi
network:
  exposure: lan

# Custom start command if needed
start: pnpm run dev
```

Then run once from your project root:
```powershell
rynk start
```

Rynk will:
1. Allocate an open port (e.g. `3000` or the next free port).
2. Wait up to `3m` for Next.js and the backend to compile.
3. Expose the project on your Wi-Fi IP.
4. Keep all child processes running in the background.

---

## 4. Managing Your Background Services

Check the status of all running services anytime from any terminal:

```powershell
# See all live services, their ports, and Wi-Fi share URLs
rynk status --all

# View live streaming logs for a specific service
rynk logs myapp-web -f
rynk logs myapp-api -f

# Get the QR code and share link again
rynk share myapp-web

# See connected users on your Wi-Fi
rynk clients myapp-web

# Restart a service in place (clients keep their sessions)
rynk restart myapp-web

# Stop hosting when you are finished
rynk stop myapp-web
rynk stop myapp-api
# Or stop everything at once:
rynk stop --all
```
