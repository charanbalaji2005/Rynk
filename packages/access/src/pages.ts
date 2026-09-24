/**
 * Pages the gateway shows to *clients* of a hosted app. They deliberately
 * reveal nothing about Rynk's internals, the host machine or other clients.
 */
const shell = (title: string, body: string, refresh?: number) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}<title>${title}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f6f5;color:#1b2530}
main{max-width:30rem;padding:2rem}
h1{font-size:1.35rem;margin:0 0 .5rem}
p{margin:.25rem 0;color:#4b5963}
@media (prefers-color-scheme:dark){body{background:#12191f;color:#e3e9ec}p{color:#9aa8b0}}
</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

export const PAGES = {
  limit: () =>
    shell("Access temporarily unavailable", "<p>The host has reached its configured maximum number of active users.</p><p>Try again in a minute.</p>", 30),
  protected: () => shell("Invite required", "<p>This link only works with an invite from the host. Ask them for a new link.</p>"),
  inviteInvalid: () => shell("This invite doesn't work anymore", "<p>It has expired, been used up, or was revoked. Ask the host for a new link.</p>"),
  blocked: () => shell("Access denied", "<p>The host has blocked access from this device.</p>"),
  ended: () => shell("Session ended", "<p>The host ended your session.</p><p>Reload the page to try again.</p>"),
  restarting: () => shell("Restarting…", "<p>The app is restarting. This page will reload automatically.</p>", 3),
  unavailable: () => shell("App not responding", "<p>The app isn't answering right now. Try again shortly.</p>", 5),
  notFound: () => shell("Not found", "<p>There's nothing here.</p>"),
};

export const TEXT: Record<keyof typeof PAGES, string> = {
  limit: "Access temporarily unavailable: the host has reached its configured maximum number of active users.\n",
  protected: "This link requires an invite from the host.\n",
  inviteInvalid: "This invite has expired, been used up, or was revoked.\n",
  blocked: "Access denied.\n",
  ended: "The host ended your session.\n",
  restarting: "The app is restarting. Try again in a few seconds.\n",
  unavailable: "The app is not responding.\n",
  notFound: "Not found.\n",
};
