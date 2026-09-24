// Zero-dependency server. Rynk sets PORT and HOST; honour both.
const http = require("node:http");
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
http
  .createServer((req, res) => {
    if (req.url === "/health") return res.end("ok");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<h1>node-http</h1><p>Served by Rynk on port ${port}.</p>`);
  })
  .listen(port, host, () => console.log(`listening on http://${host}:${port}`));
