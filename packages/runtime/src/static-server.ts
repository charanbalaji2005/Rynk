/**
 * Hardened static file server run as a child process by StaticRuntime.
 * usage: node static-server.js <dir> <port> <host>
 *  - never serves dotfiles or sensitive files (.env, keys, databases)
 *  - resolves symlinks and refuses anything outside the root
 *  - SPA fallback to index.html for extensionless routes
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { isInside, isSensitivePath } from "@rynk/security";

const [dirArg, portArg, hostArg] = process.argv.slice(2);
const root = fs.realpathSync(path.resolve(dirArg ?? "."));
const port = Number(portArg ?? 8080);
const host = hostArg ?? "0.0.0.0";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".wasm": "application/wasm",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf", ".map": "application/json",
};

function send(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const start = Date.now();
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed");
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    return send(res, 400, "Bad Request");
  }
  const segments = urlPath.split("/");
  if (isSensitivePath(urlPath) || segments.some((s) => s.startsWith(".") && s !== ".well-known")) return send(res, 404, "Not Found");

  let file = path.join(root, urlPath);
  if (!isInside(root, file)) return send(res, 404, "Not Found");
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  } catch {
    // SPA fallback: extensionless paths serve index.html
    if (!path.extname(urlPath)) file = path.join(root, "index.html");
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile() || !isInside(root, file)) return send(res, 404, "Not Found");
    const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      return res.end();
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": st.size,
      etag,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
    res.on("finish", () => console.log(`${req.method} ${urlPath} ${res.statusCode} ${Date.now() - start}ms`));
  });
});

server.listen(port, host, () => console.log(`Static server listening on http://${host}:${port}`));
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
