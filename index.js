/**
 * CRAWLTOLL™ — Turn AI scraping into revenue.
 * x402 (HTTP-402) middleware: bots pay per fetch in USDC, humans browse free.
 *
 * (c) Script Master Labs LLC — BEAST MODE build standard
 */

const fs = require("fs");
const path = require("path");
let ap2;
try { ap2 = require("./ap2.js"); } catch (_) { ap2 = null; }

// ---------------------------------------------------------------------------
// Startup environment validation
// ---------------------------------------------------------------------------
function validateEnv(cfg) {
  const warnings = [];
  if (!cfg.payTo || cfg.payTo === "0xYOUR_WALLET_ADDRESS_HERE") {
    warnings.push("CRAWLTOLL_PAYTO is not set — payments will go to the default demo address");
  }
  if (!cfg.payTo || !/^0x[0-9a-fA-F]{40}$/.test(cfg.payTo)) {
    warnings.push("CRAWLTOLL_PAYTO does not look like a valid EVM address");
  }
  for (const w of warnings) {
    console.warn("[CRAWLTOLL] WARNING:", w);
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULTS = {
  // payTo intentionally has no default — must be set via env var or config.
  // A missing payTo will trigger a startup warning.
  payTo: process.env.CRAWLTOLL_PAYTO || "",
  network: "base",                       // "base" | "base-sepolia"
  priceUSDC: "0.005",                    // price per fetch, in USDC
  facilitatorUrl: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
  bazaarDiscoverable: (process.env.X402_BAZAAR_DISCOVERABLE || "true") === "true",
  bazaarListing: {
    name: "CRAWLTOLL — AI Crawler Paywall Feeds",
    description: "Pay-per-fetch trading signals and data: squeeze hits, graded options picks, market scans. AP2-native (verifies Google Agent Payments Protocol mandates). By Script Master Labs.",
    provider: "Script Master Labs LLC",
    category: "data-feeds",
  },
  description: "Pay-per-fetch access to fresh content via CRAWLTOLL",
  freePaths: ["/robots.txt", "/llms.txt", "/agents.json", "/sitemap.xml", "/.well-known", "/favicon.ico"],
  chargeHumans: false,
  maxTimeoutSeconds: 60,
  // AP2 (Google Agent Payments Protocol):
  //   "off"      — ignore mandates (default; pure x402)
  //   "optional" — if an X-AP2-MANDATE is present, verify it; reject only if invalid
  //   "required" — agents MUST present a valid AP2 mandate to pay
  ap2Mode: process.env.AP2_MODE || "optional",
  ap2TrustedIssuers: {},                 // { "did:...#key": publicKeyPem }
};

const USDC = {
  "base":         { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chainId: 8453, name: "USDC" },
  "base-sepolia": { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", chainId: 84532, name: "USDC" },
};

// ---------------------------------------------------------------------------
// Bot detection — known AI crawlers / agent fingerprints
// ---------------------------------------------------------------------------
const AI_BOT_PATTERNS = [
  /gptbot/i, /oai-searchbot/i, /chatgpt-user/i,
  /claudebot/i, /claude-web/i, /anthropic/i,
  /perplexitybot/i, /perplexity-user/i,
  /google-extended/i, /googleother/i, /gemini/i,
  /bytespider/i, /ccbot/i, /cohere/i, /diffbot/i,
  /facebookbot/i, /meta-externalagent/i,
  /amazonbot/i, /applebot-extended/i,
  /youbot/i, /mistral/i, /ai2bot/i, /omgili/i,
  /timpibot/i, /petalbot/i, /scrapy/i,
  /python-requests/i, /python-httpx/i, /aiohttp/i,
  /go-http-client/i, /node-fetch/i, /axios/i, /curl/i, /wget/i,
  /headless/i, /phantom/i, /puppeteer/i, /playwright/i,
  /\bbot\b/i, /\bcrawler\b/i, /\bspider\b/i, /\bscraper\b/i, /agent/i,
];

function isAIAgent(req) {
  const ua = (req.headers["user-agent"] || "").toString();
  if (!ua) return true; // no UA = automated
  if (req.headers["x-payment"]) return true; // already speaking x402
  return AI_BOT_PATTERNS.some((re) => re.test(ua));
}

// ---------------------------------------------------------------------------
// x402 payment requirements builder
// ---------------------------------------------------------------------------
function toAtomicUSDC(amountStr) {
  // USDC = 6 decimals
  const [whole, frac = ""] = String(amountStr).split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return (BigInt(whole || "0") * 1000000n + BigInt(fracPadded)).toString();
}

function buildPaymentRequirements(cfg, req) {
  const token = USDC[cfg.network] || USDC["base"];
  // Validate host header to prevent header injection into the resource URL
  const rawHost = req.headers.host || cfg.host || "unknown";
  const safeHost = rawHost.replace(/[^\w.:\-[\]]/g, "");
  const resource = `${req.protocol || "https"}://${safeHost}${req.originalUrl || req.url}`;
  const reqs = {
    scheme: "exact",
    network: cfg.network,
    maxAmountRequired: toAtomicUSDC(cfg.priceUSDC),
    resource,
    description: (cfg.bazaarListing && cfg.bazaarListing.description) || cfg.description,
    mimeType: "application/json",
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    asset: token.asset,
    extra: { name: token.name, version: "2" },
  };
  if (cfg.bazaarDiscoverable) {
    reqs.discoverable = true;
    reqs.outputSchema = {
      name: (cfg.bazaarListing && cfg.bazaarListing.name) || "CRAWLTOLL feed",
      provider: (cfg.bazaarListing && cfg.bazaarListing.provider) || "Script Master Labs LLC",
      category: (cfg.bazaarListing && cfg.bazaarListing.category) || "data-feeds",
      ap2: true,
    };
  }
  return reqs;
}

// ---------------------------------------------------------------------------
// Facilitator verify + settle
// ---------------------------------------------------------------------------
async function facilitatorCall(cfg, endpoint, paymentHeader, requirements) {
  try {
    const res = await fetch(`${cfg.facilitatorUrl}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentHeader,
        paymentRequirements: requirements,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { isValid: false, success: false, error: `facilitator_${endpoint}_http_${res.status}` };
    return res.json();
  } catch (e) {
    return { isValid: false, success: false, error: "facilitator_unreachable" };
  }
}

// ---------------------------------------------------------------------------
// Revenue ledger (flat-file; swap for DB in prod)
// ---------------------------------------------------------------------------
function logRevenue(cfg, entry) {
  try {
    const file = cfg.ledgerFile || path.join(process.cwd(), "crawltoll-ledger.jsonl");
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch (_) { /* never block the request on ledger I/O */ }
}

// ---------------------------------------------------------------------------
// Consistent JSON error response
// ---------------------------------------------------------------------------
function jsonError(res, status, message, code, extra = {}) {
  res.status(status);
  res.set("Content-Type", "application/json");
  res.json({ error: message, code, ...extra });
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------
function crawltoll(userConfig = {}) {
  // Load crawltoll.config.json if present
  let fileConfig = {};
  try {
    const p = path.join(process.cwd(), "crawltoll.config.json");
    if (fs.existsSync(p)) fileConfig = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {}

  const cfg = { ...DEFAULTS, ...fileConfig, ...userConfig };

  // Warn on startup if config looks wrong
  validateEnv(cfg);

  return async function crawltollMiddleware(req, res, next) {
    try {
      const urlPath = (req.path || req.url || "").split("?")[0];

      // 1. Free paths always pass (discovery files must stay open)
      if (cfg.freePaths.some((p) => urlPath.startsWith(p))) return next();

      // 2. Humans browse free (unless chargeHumans is on)
      // Note: isAIAgent is for routing only; payment token is always verified
      // server-side regardless of User-Agent.
      if (!cfg.chargeHumans && !isAIAgent(req)) return next();

      const requirements = buildPaymentRequirements(cfg, req);
      const paymentHeader = req.headers["x-payment"];

      // 2.5 AP2 mandate gate (Google Agent Payments Protocol)
      if (ap2 && cfg.ap2Mode && cfg.ap2Mode !== "off") {
        const mandate = ap2.mandateFromRequest(req);
        if (mandate) {
          const verdict = ap2.verifyMandate(mandate, {
            resource: requirements.resource,
            amountAtomicUSDC: parseInt(requirements.maxAmountRequired, 10),
            payTo: cfg.payTo,
            trustedIssuers: cfg.ap2TrustedIssuers || {},
          });
          if (!verdict.valid) {
            logRevenue(cfg, { t: Date.now(), event: "ap2_mandate_invalid", path: urlPath, reason: verdict.reason });
            return jsonError(res, 402, "AP2 mandate invalid: " + verdict.reason, "AP2_MANDATE_INVALID", {
              x402Version: 1,
              ap2: { required: cfg.ap2Mode === "required", checks: verdict.checks },
              accepts: [requirements],
            });
          }
          res.set("X-AP2-VERIFIED", "true");
        } else if (cfg.ap2Mode === "required") {
          logRevenue(cfg, { t: Date.now(), event: "ap2_mandate_missing", path: urlPath });
          return jsonError(res, 402, "AP2 mandate required. Send X-AP2-MANDATE header (base64 VC bundle).", "AP2_MANDATE_REQUIRED", {
            x402Version: 1,
            ap2: { required: true, spec: "https://ap2-protocol.org/specification/" },
            accepts: [requirements],
          });
        }
      }

      // 3. No payment yet → issue the 402 challenge
      if (!paymentHeader) {
        logRevenue(cfg, { t: Date.now(), event: "challenge", path: urlPath, ua: req.headers["user-agent"] || "" });
        return jsonError(res, 402, "X-PAYMENT header is required", "PAYMENT_REQUIRED", {
          x402Version: 1,
          accepts: [requirements],
        });
      }

      // 4. Verify payment — server-side; never trust client-supplied amount
      const verification = await facilitatorCall(cfg, "verify", paymentHeader, requirements);
      if (!verification.isValid) {
        logRevenue(cfg, { t: Date.now(), event: "invalid_payment", path: urlPath, reason: verification.invalidReason || verification.error });
        return jsonError(res, 402, "Payment verification failed", "PAYMENT_INVALID", {
          x402Version: 1,
          accepts: [requirements],
        });
      }

      // 5. Settle on-chain
      const settlement = await facilitatorCall(cfg, "settle", paymentHeader, requirements);
      if (!settlement.success) {
        logRevenue(cfg, { t: Date.now(), event: "settle_failed", path: urlPath, reason: settlement.error });
        return jsonError(res, 402, "Payment settlement failed", "PAYMENT_SETTLE_FAILED", {
          x402Version: 1,
          accepts: [requirements],
        });
      }

      // 6. Paid — unlock content
      logRevenue(cfg, {
        t: Date.now(),
        event: "paid",
        path: urlPath,
        amountUSDC: cfg.priceUSDC,
        network: cfg.network,
        tx: settlement.txHash || settlement.transaction || null,
        ua: req.headers["user-agent"] || "",
      });
      res.set("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settlement)).toString("base64"));
      return next();
    } catch (err) {
      // Fail open for humans, fail closed for bots; never expose internal errors
      if (!isAIAgent(req)) return next();
      return jsonError(res, 402, "Payment processing error", "CRAWLTOLL_INTERNAL_ERROR", { x402Version: 1 });
    }
  };
}

// ---------------------------------------------------------------------------
// Revenue stats helper (for /crawltoll/stats dashboards)
// ---------------------------------------------------------------------------
function getStats(ledgerFile) {
  const file = ledgerFile || path.join(process.cwd(), "crawltoll-ledger.jsonl");
  if (!fs.existsSync(file)) return { paidFetches: 0, challenges: 0, revenueUSDC: "0.000000" };
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  let paid = 0, challenges = 0, revenue = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.event === "paid") { paid++; revenue += parseFloat(e.amountUSDC || 0); }
      if (e.event === "challenge") challenges++;
    } catch (_) {}
  }
  return { paidFetches: paid, challenges, revenueUSDC: revenue.toFixed(6) };
}

module.exports = crawltoll;
module.exports.crawltoll = crawltoll;
module.exports.isAIAgent = isAIAgent;
module.exports.getStats = getStats;
module.exports.buildPaymentRequirements = buildPaymentRequirements;

// AP2 mandate verification (Google Agent Payments Protocol)
try { module.exports.ap2 = require("./ap2.js"); } catch (_) {}

// ---------------------------------------------------------------------------
// AI Visitor intelligence — who's been crawling? (parses logged user-agents)
// ---------------------------------------------------------------------------
const KNOWN_AI_BOTS = [
  ["GPTBot", "OpenAI"], ["OAI-SearchBot", "OpenAI"], ["ChatGPT-User", "OpenAI"],
  ["ClaudeBot", "Anthropic"], ["Claude-Web", "Anthropic"], ["anthropic-ai", "Anthropic"],
  ["PerplexityBot", "Perplexity"], ["Perplexity-User", "Perplexity"],
  ["Google-Extended", "Google"], ["GoogleOther", "Google"],
  ["Bytespider", "ByteDance"], ["Amazonbot", "Amazon"], ["Applebot", "Apple"],
  ["CCBot", "CommonCrawl"], ["Meta-ExternalAgent", "Meta"], ["facebookexternalhit", "Meta"],
  ["cohere-ai", "Cohere"], ["YouBot", "You.com"], ["Diffbot", "Diffbot"],
  ["DuckAssistBot", "DuckDuckGo"], ["MistralAI", "Mistral"],
];

function classifyUA(ua) {
  const s = (ua || "").toString();
  for (const [pat, org] of KNOWN_AI_BOTS) {
    if (s.toLowerCase().includes(pat.toLowerCase())) return { bot: pat, org };
  }
  return null;
}

function getVisitors(ledgerFile, limit = 50) {
  const file = ledgerFile || path.join(process.cwd(), "crawltoll-ledger.jsonl");
  if (!fs.existsSync(file)) {
    return { totalAiHits: 0, uniqueBots: 0, byBot: {}, byOrg: {}, recent: [], note: "No ledger yet — no visitors logged." };
  }
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const byBot = {}, byOrg = {}, recent = [];
  let totalAiHits = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (!e.ua) continue;
      const hit = classifyUA(e.ua);
      if (!hit) continue;
      totalAiHits++;
      byBot[hit.bot] = (byBot[hit.bot] || 0) + 1;
      byOrg[hit.org] = (byOrg[hit.org] || 0) + 1;
      recent.push({ ts: new Date(e.t).toISOString(), bot: hit.bot, org: hit.org, path: e.path, event: e.event });
    } catch (_) {}
  }
  return {
    totalAiHits,
    uniqueBots: Object.keys(byBot).length,
    byBot,
    byOrg,
    recent: recent.slice(-limit).reverse(),
    note: totalAiHits === 0
      ? "Infrastructure live and AI-welcoming. No identified AI crawlers have hit the paid feeds yet — expected this early in the agentic economy."
      : totalAiHits + " AI crawler hit(s) across " + Object.keys(byOrg).length + " organization(s).",
  };
}

module.exports.getVisitors = getVisitors;
module.exports.classifyUA = classifyUA;
