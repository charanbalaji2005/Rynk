# Discovery: many laptops, one network

Run `npx rynk` on several computers on the same network and they find each
other automatically:

```
$ rynk apps
Rynk network

● laptop-a  192.168.1.42
    frontend         http://192.168.1.42:5173  Vite
● laptop-b  192.168.1.43
    backend          http://192.168.1.43:8000  FastAPI
● laptop-c  192.168.1.44
    ai               http://192.168.1.44:11434
```

Any browser can open those links; the other laptops don't need Rynk to *use*
an app, only to *list* them. Every computer can host and discover at the same
time, and there's no limit on how many take part.

## What's shared

Each node publishes a read-only description at `GET http://<ip>:7780/rynk/v1/node`:
node name, hostname, platform, version, addresses, and the apps it
advertises (name, framework, runtime, share link, status, open/invite-only).
Never credentials, environment variables, paths, logs or visitor data.
Apps in local mode or started with `--no-advertise` aren't listed.

Other nodes can *read* this; nothing on the network can control another
machine's Rynk.

## How it works

- **Identity** — on first run each node creates an Ed25519 key pair in
  `RYNK_HOME/node.json` (owner-only). Its id is `rynk-node-` + the first 24
  hex digits of the public key's SHA-256, so the id *is* a commitment to the
  key. Machines are tracked by id, so IP changes don't create duplicates. Set
  `RYNK_NODE_NAME` for a friendlier name.
- **Authentication** — a node's description is signed with its private key
  and time-stamped. A node is listed only if its public key hashes to the
  announced id, the signature verifies and the timestamp is within ten
  minutes. A machine can therefore never impersonate another node's id;
  unsigned or mismatched announcements are ignored (and logged once).
- **UDP beacons** — every ~5 s (jittered), a ~150-byte message to multicast
  group 239.255.73.79 port 7779 on each LAN interface, TTL 1 so it never
  leaves the network. `query` asks for immediate answers; `bye` announces a
  clean shutdown.
- **mDNS / DNS-SD** — `_rynk._tcp.local` service records containing only id,
  revision and version.
- **Revisions** — announcements carry a revision number. Full details are
  fetched only when it changes (new app, stopped app, new IP), so nothing
  large is ever broadcast and traffic stays constant as networks grow.
- **Heartbeat & TTL** — a node is ONLINE when heard from in the last 15 s,
  UNREACHABLE up to 60 s, then OFFLINE; a node that says goodbye is OFFLINE
  immediately and stays so until it announces itself again. Offline nodes are
  forgotten after an hour; `rynk nodes` history (name, key, last address) is
  kept 30 days in the local database. Before
  demoting a node the registry pings its info endpoint directly, so it keeps
  working on networks that filter multicast once a node has been seen.

## Network changes

When your IP changes (new Wi-Fi, DHCP renewal) Rynk updates share links,
QR codes, the popup and your node's announcement within about five seconds.

## Troubleshooting

`rynk network` shows which providers are running; `rynk network test`
checks discovery and node communication end to end. Discovery needs:

| Port | Protocol | Purpose |
| --- | --- | --- |
| 7779 | UDP (multicast 239.255.73.79) | Beacons / heartbeat |
| 5353 | UDP (multicast 224.0.0.251) | mDNS |
| 7780 | TCP | Read-only node info |

Guest Wi-Fi and some office networks isolate clients; discovery (and the apps
themselves) won't work across that. `RYNK_DISCOVERY=off|udp|mdns|all`
controls the providers; `RYNK_DISCOVERY_PORT` and `RYNK_NODE_PORT` change ports.
