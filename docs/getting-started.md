# Getting started

## 1. Install Node.js 22.13+

`node -v` to check. Node projects, static sites and custom commands need
nothing else; other ecosystems need their own toolchain. `rynk doctor` shows
what's installed.

## 2. Host a project

```bash
cd path/to/your/project
npx rynk
```

A small **Host with Rynk** window opens with the detected framework, command,
port, network and IP. Adjust anything you like — for example set **Max active
users** — and click **Start Hosting**. (No desktop? The same form appears in the
terminal.)

The terminal shows each stage and then:

```
● LIVE  my-vite-app
Share:   http://192.168.1.42:5173
Users:   0 / 10
```

Send the **Share** link to anyone on the same Wi-Fi, or click **QR code** in
the window and scan it with a phone. Nobody needs to install anything.

Press **Ctrl+C** (or **Stop Hosting**) to stop. To keep it running after you
close the terminal, use `rynk start` instead.

## 3. Watch and control access

```bash
rynk clients              # who's connected
rynk limit 5              # at most 5 active users
rynk share --invite       # invite-only link
rynk clients disconnect <session>
```

## 4. See the other laptops

On another computer on the same network, run `npx rynk` in its project (or
just `npx rynk apps`). Every Rynk computer lists every shared app:

```bash
rynk apps
rynk nodes
```

## 5. Skip the window

```bash
rynk --yes                          # accept what was detected
rynk start --lan --non-interactive  # automation / CI
rynk plan                           # just show what would happen
```

## 6. Hosting Full-Stack Apps (Database + API + Frontend)

If your project includes a database (PostgreSQL/Redis via Docker), a backend API, and a frontend, see the **[Full-Stack Setup Guide](fullstack-guide.md)** to run all components persistently without terminal exits.

## When something doesn't work

```bash
rynk doctor
rynk network test
```

- **"couldn't work out how to start this project"** — `rynk --cmd "python server.py"`.
- **"started but never answered"** — the app uses a fixed port: `rynk --port <it>`.
- **Phone can't open the link** — see [troubleshooting](troubleshooting.md#other-devices-cant-connect).
