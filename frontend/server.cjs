const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const httpProxy = require("http-proxy");

const dev = false;
const hostname = "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const proxy = httpProxy.createProxyServer({ target: "http://localhost:3001", ws: true, proxyTimeout: 0, timeout: 0 });

proxy.on("error", (err, _req, res) => {
  if (res && typeof res.writeHead === "function") {
    res.writeHead(502);
    res.end("Proxy error");
  }
  console.error("proxy error:", err.message);
});

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    if (parsedUrl.pathname?.startsWith("/socket.io")) {
      req.socket.setTimeout(0);
      res.socket?.setTimeout(0);
      proxy.web(req, res);
    } else {
      handle(req, res, parsedUrl);
    }
  });
  server.timeout = 0;
  server.keepAliveTimeout = 0;

  server.on("upgrade", (req, socket, head) => {
    const parsedUrl = parse(req.url, true);
    if (parsedUrl.pathname?.startsWith("/socket.io")) {
      proxy.ws(req, socket, head);
    }
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
