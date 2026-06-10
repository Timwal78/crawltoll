/**
 * CRAWLTOLL™ demo/production server — Render-ready
 * Serves static content behind the x402 toll + live revenue stats at /crawltoll/stats
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crawltoll = require("./index.js");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, "public");

const mw = crawltoll({
  payTo: process.env.CRAWLTOLL_PAYTO || "0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700",
  network: process.env.CRAWLTOLL_NETWORK || "base",
  priceUSDC: process.env.CRAWLTOLL_PRICE || "0.005",
  ledgerFile: process.env.CRAWLTOLL_LEDGER || "/tmp/crawltoll-ledger.jsonl",
});

const MIME = { ".html": "text/html", ".json": "application/json", ".txt": "text/plain", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };

function serveStatic(req, res) {
  let p = req.path === "/" ? "/index.html" : req.path;
  // stats endpoint
  if (p === "/crawltoll/stats") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(crawltoll.getStats(process.env.CRAWLTOLL_LEDGER || "/tmp/crawltoll-ledger.jsonl"), null, 2));
  }
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[\/\\])+/, ""));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    return res.end(fs.readFileSync(file));
  }
  res.statusCode = 404;
  res.end("Not found");
}

http.createServer((req, res) => {
  req.path = req.url.split("?")[0];
  req.originalUrl = req.url;
  req.protocol = "https";
  res.status = (c) => { res.statusCode = c; return res; };
  res.set = (k, v) => { res.setHeader(k, v); return res; };
  res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
  mw(req, res, () => serveStatic(req, res));
}).listen(PORT, () => console.log(`CRAWLTOLL toll booth live on :${PORT}`));
