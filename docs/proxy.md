# Name routes

Besides `http://localhost:<port>`, every hosted project gets a readable
address on this computer:

```
http://<name>.localhost:7777/
```

Browsers resolve `*.localhost` to your own machine. The name proxy listens on
127.0.0.1 only and forwards to the project's access gateway, so it is purely a
convenience on the host; people on the network use the share link.
`rynk routes` lists them.

`RYNK_PROXY=caddy` (with `RYNK_CADDY_ADMIN`) manages these routes through a
running Caddy instead of the built-in proxy.
