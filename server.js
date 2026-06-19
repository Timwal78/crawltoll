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
const clearinghouse = require("./clearinghouse.js");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, "public"));
const LEDGER = process.env.CRAWLTOLL_LEDGER || "/tmp/crawltoll-ledger.jsonl";

// Admin secret — required to access /crawltoll/stats and /crawltoll/visitors.
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const ADMIN_SECRET = process.env.CRAWLTOLL_ADMIN_SECRET || "";
if (!ADMIN_SECRET) {
  console.warn("[CRAWLTOLL] WARNING: CRAWLTOLL_ADMIN_SECRET is not set. /crawltoll/stats and /crawltoll/visitors will be disabled.");
}

// Validate required env vars on startup
const CRAWLTOLL_PAYTO = process.env.CRAWLTOLL_PAYTO || "";
if (!CRAWLTOLL_PAYTO || !/^0x[0-9a-fA-F]{40}$/.test(CRAWLTOLL_PAYTO)) {
  console.error("[CRAWLTOLL] FATAL: CRAWLTOLL_PAYTO is missing or invalid. Set it to a valid EVM address.");
  process.exit(1);
}

const baseConfig = {
  payTo: CRAWLTOLL_PAYTO,
  network: process.env.CRAWLTOLL_NETWORK || "base",
  ledgerFile: LEDGER,
};

const mw = crawltoll({ ...baseConfig, priceUSDC: process.env.CRAWLTOLL_PRICE || "0.005" });

// Per-feed toll middlewares (different price per endpoint)
const feedMw = {};
for (const [p, price] of Object.entries(FEED_PRICING)) {
  feedMw[p] = crawltoll({ ...baseConfig, priceUSDC: price, chargeHumans: true });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Security headers applied to every response
function addSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // Content-Security-Policy: restrictive default; adjust if serving scripts/styles
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none';"
  );
  // HSTS — only meaningful over HTTPS; harmless over HTTP in dev
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
}

// Verify admin secret via Authorization: Bearer <secret> or ?secret=<secret>
function isAdminAuthorized(req) {
  if (!ADMIN_SECRET) return false;
  const authHeader = req.headers["authorization"] || "";
  if (authHeader.startsWith("Bearer ")) {
    const provided = authHeader.slice(7).trim();
    // Constant-time comparison to prevent timing attacks
    const crypto = require("crypto");
    const a = Buffer.from(provided);
    const b = Buffer.from(ADMIN_SECRET);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}

function serveStatic(req, res) {
  let p = req.path === "/" ? "/index.html" : req.path;

  // Admin-only stats endpoint
  if (p === "/crawltoll/stats") {
    if (!isAdminAuthorized(req)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Bearer realm="crawltoll-admin"');
      return res.end(JSON.stringify({ error: "Unauthorized", code: "ADMIN_AUTH_REQUIRED" }));
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(crawltoll.getStats(LEDGER), null, 2));
  }

  // Admin-only visitor intelligence endpoint
  if (p === "/crawltoll/visitors") {
    if (!isAdminAuthorized(req)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Bearer realm="crawltoll-admin"');
      return res.end(JSON.stringify({ error: "Unauthorized", code: "ADMIN_AUTH_REQUIRED" }));
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(crawltoll.getVisitors(LEDGER), null, 2));
  }

  // ── CLEARINGHOUSE ROUTES ──────────────────────────────────────────────────

  // POST /clearinghouse/register — publisher registration (JSON body via GET params for simplicity)
  // Full POST body parsing done inline; this is a minimal HTTP server with no body-parser dep.
  if (p === "/clearinghouse/stats") {
    // Public global stats — how much has been paid to publishers by AI company
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(clearinghouse.getGlobalStats(), null, 2));
  }

  if (p === "/clearinghouse/queue") {
    // Admin: settlement queue — wallets that need RLUSD transfers
    if (!isAdminAuthorized(req)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Bearer realm="crawltoll-admin"');
      return res.end(JSON.stringify({ error: "Unauthorized", code: "ADMIN_AUTH_REQUIRED" }));
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const minThreshold = parseFloat(new URL(req.url, "http://x").searchParams.get("min") || "0.10");
    return res.end(JSON.stringify(clearinghouse.getSettlementQueue(minThreshold), null, 2));
  }

  if (p === "/clearinghouse/dashboard") {
    // Publisher dashboard — authenticated by X-Publisher-Token header
    const token = req.headers["x-publisher-token"] || "";
    if (!token) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "X-Publisher-Token header required", code: "TOKEN_REQUIRED" }));
    }
    const pub = clearinghouse.getPublisherByToken(token);
    if (!pub) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "Invalid publisher token", code: "INVALID_TOKEN" }));
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(clearinghouse.getPublisherDashboard(pub.publisherId), null, 2));
  }

  if (p === "/.well-known/vapl.json") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(JSON.stringify(vapl.buildManifest(), null, 2));
  }

  // Path traversal guard: resolve the full path and confirm it's inside PUBLIC_DIR
  const normalized = path.normalize(p);
  // Reject any path component that tries to escape the public dir
  if (normalized.includes("..")) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "Invalid path", code: "INVALID_PATH" }));
  }
  const filePath = path.join(PUBLIC_DIR, normalized);
  // Resolved path must start with PUBLIC_DIR (defense-in-depth)
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "Invalid path", code: "INVALID_PATH" }));
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.setHeader("Content-Type", MIME[path.extname(filePath)] || "application/octet-stream");
    return res.end(fs.readFileSync(filePath));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found", code: "NOT_FOUND" }));
}

http.createServer((req, res) => {
  try {
    req.path = (req.url || "/").split("?")[0];
    req.originalUrl = req.url;
    req.protocol = "https";
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = (k, v) => { res.setHeader(k, v); return res; };
    res.json = (o) => {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(o));
    };

    // Apply security headers to all responses
    addSecurityHeaders(res);

    // Handle OPTIONS preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    // POST /clearinghouse/register — publisher onboarding (must come before the GET-only guard)
    if (req.method === "POST" && req.path === "/clearinghouse/register") {
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 8192) req.destroy(); });
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          const result = clearinghouse.registerPublisher(data);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.statusCode = 201;
          res.end(JSON.stringify({
            ...result,
            message: "Publisher registered. Store your apiToken — it is shown only once.",
            revenueShare: "70% of all AI crawler fees are settled to your XRPL wallet in RLUSD.",
          }));
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: err.message, code: "REGISTRATION_FAILED" }));
        }
      });
      req.on("error", () => { res.statusCode = 400; res.end(); });
      return;
    }

    // POST /clearinghouse/settle — admin: mark a publisher's balance as settled after XRPL tx
    if (req.method === "POST" && req.path === "/clearinghouse/settle") {
      if (!isAdminAuthorized(req)) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Bearer realm="crawltoll-admin"');
        return res.end(JSON.stringify({ error: "Unauthorized", code: "ADMIN_AUTH_REQUIRED" }));
      }
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 4096) req.destroy(); });
      req.on("end", () => {
        try {
          const { publisherId, amountRLUSD, txHash } = JSON.parse(body);
          clearinghouse.markSettled(publisherId, parseFloat(amountRLUSD), txHash);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true, publisherId, amountRLUSD, txHash }));
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: err.message, code: "SETTLE_FAILED" }));
        }
      });
      req.on("error", () => { res.statusCode = 400; res.end(); });
      return;
    }

    // Only allow GET and HEAD for all other routes
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD, OPTIONS, POST");
      return res.end(JSON.stringify({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }));
    }

    // /feed index is free discovery; /feed/* are priced data products behind the toll
    if (req.path === "/feed") {
      return serveFeed("/feed")
        .then((d) => res.json(d))
        .catch(() => { res.statusCode = 502; res.end(JSON.stringify({ error: "Feed error", code: "FEED_ERROR" })); });
    }
    if (FEED_PRICING[req.path]) {
      return feedMw[req.path](req, res, async () => {
        try {
          const data = await serveFeed(req.path);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
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
        } catch (_) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: "Feed upstream error", code: "FEED_UPSTREAM_ERROR" }));
        }
      });
    }

    // Everything else: page toll + static
    mw(req, res, () => {
      // Record clearinghouse revenue split when a paid crawl succeeds
      try {
        const priceUSDC = parseFloat(process.env.CRAWLTOLL_PRICE || "0.005");
        const ua = req.headers["user-agent"] || "";
        if (clearinghouse.detectAICompany(ua)) {
          const host = (req.headers["host"] || "").split(":")[0];
          clearinghouse.recordCrawl({
            domain: host,
            url: `https://${host}${req.path}`,
            userAgent: ua,
            amountUSDC: priceUSDC,
          });
        }
      } catch (_) {}

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
  } catch (err) {
    // Top-level catch: never expose stack traces
    try {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Internal server error", code: "INTERNAL_ERROR" }));
    } catch (_) {}
  }
}).listen(PORT, () => console.log(`CRAWLTOLL toll booth + signal feed live on :${PORT}`));
