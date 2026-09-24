# Public sharing

By default Rynk links only work on your network. To share with someone
elsewhere:

```bash
rynk share --public
```

Rynk asks for confirmation, then starts a Cloudflare quick tunnel to the
app's access gateway (`cloudflared tunnel --url http://127.0.0.1:<share port>`) and prints a
`https://<random>.trycloudflare.com` link plus a QR code. The link works as
long as the project runs.

```bash
rynk share --stop      # close it
```

## Requirements

Install `cloudflared` (`brew install cloudflared`, `winget install
Cloudflare.cloudflared`, or the Linux package). No Cloudflare account is
needed for quick tunnels.

Because the tunnel ends at the gateway, **max users and invite-only links apply
to internet visitors too** — `rynk share --invite` is a good pairing. All tunnel
visitors appear as `127.0.0.1` in `rynk clients`, so disconnect by session
rather than blocking by address.

You can also pick **Public tunnel** in the popup or pass `--public` when starting.

## Before you share

- Anyone with the link can use your app. Don't share apps with admin panels,
  debug consoles or real data.
- Quick tunnels are for demos; they aren't meant for production traffic.

## Other providers

Exposure providers are pluggable. `--provider <name>` selects one;
`relay` is reserved for a hosted relay and currently reports that it is
unavailable. See [plugins.md](plugins.md) to add ngrok, Tailscale Funnel or a
self-hosted relay.
