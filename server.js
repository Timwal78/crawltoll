/**
 * CRAWLTOLL™ demo/production server — Render-ready
 * Serves static content behind the x402 toll + live revenue stats at /crawltoll/stats
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crawltoll = require("./index.js");
const { serveFeed, FEED_PRICING } = require("./feed.js");
const vapl = require("./vapl.js");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, "public");
const LEDGER = process.env.CRAWLTOLL_LEDGER || "/tmp/crawltoll-ledger.jsonl";

const baseConfig = {
  payTo: process.env.CRAWLTOLL_PAYTO || "0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700",
  network: process.env.CRAWLTOLL_NETWORK || "base",
  ledgerFile: LEDGER,
};

const mw = crawltoll({ ...baseConfig, priceUSDC: process.env.CRAWLTOLL_PRICE || "0.005" });

// Per-feed toll middlewares (different price per endpoint)
const feedMw = {};
for (const [p, price] of Object.entries(FEED_PRICING)) {
  feedMw[p] = crawltoll({ ...baseConfig, priceUSDC: price, chargeHumans: true }); // feeds are paid for everyone — it's a data product
}

const MIME = { ".html": "text/html", ".json": "application/json", ".txt": "text/plain", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };

function serveStatic(req, res) {
  let p = req.path === "/" ? "/index.html" : req.path;
  // stats endpoint
  if (p === "/crawltoll/stats") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(crawltoll.getStats(process.env.CRAWLTOLL_LEDGER || "/tmp/crawltoll-ledger.jsonl"), null, 2));
  }
  // AI visitor intelligence — who's been crawling
  if (p === "/crawltoll/visitors") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(crawltoll.getVisitors(process.env.CRAWLTOLL_LEDGER || "/tmp/crawltoll-ledger.jsonl"), null, 2));
  }
  if (p === "/.well-known/vapl.json") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.end(JSON.stringify(vapl.buildManifest(), null, 2));
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

  // /feed index is free discovery; /feed/* are priced data products behind the toll
  if (req.path === "/feed") {
    return serveFeed("/feed").then((d) => res.json(d)).catch(() => { res.statusCode = 502; res.end("feed error"); });
  }
  if (FEED_PRICING[req.path]) {
    return feedMw[req.path](req, res, async () => {
      try {
        const data = await serveFeed(req.path);
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        // Emit VAPL VC for successful paid data feed access
        try {
          const soul = vapl.getSoul();
          const wallet = req.headers["x-agent-wallet"] || "";
          const vc = vapl.issueInteractionVc(soul, vapl.agentDid(wallet), "CrawltollFetch",
            `https://crawltoll.onrender.com${req.path}`, "success");
          const vcB64 = Buffer.from(JSON.stringify(vc)).toString("base64url");
          res.setHeader("X-VAPL-VC", vcB64);
          res.setHeader("X-VAPL-Issuer", soul.did);
          res.setHeader("X-VAPL-VC-ID", vc.id);
        } catch (_) {}
        res.end(JSON.stringify(data));
      } catch (e) {
        res.statusCode = 502; res.end(JSON.stringify({ error: "feed_upstream_error" }));
      }
    });
  }

  // everything else: page toll + static — emit VAPL VC on successful toll pass
  mw(req, res, () => {
    const origEnd = res.end.bind(res);
    res.end = function(chunk) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          const soul = vapl.getSoul();
          const wallet = req.headers["x-agent-wallet"] || "";
          const vc = vapl.issueInteractionVc(soul, vapl.agentDid(wallet), "CrawltollFetch",
            `https://crawltoll.onrender.com${req.path}`, "success");
          const vcB64 = Buffer.from(JSON.stringify(vc)).toString("base64url");
          res.setHeader("X-VAPL-VC", vcB64);
          res.setHeader("X-VAPL-Issuer", soul.did);
          res.setHeader("X-VAPL-VC-ID", vc.id);
        } catch (_) {}
      }
      return origEnd(chunk);
    };
    serveStatic(req, res);
  });
}).listen(PORT, () => console.log(`CRAWLTOLL toll booth + signal feed live on :${PORT}`));
