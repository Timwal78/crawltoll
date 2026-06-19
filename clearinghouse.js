/**
 * CRAWLTOLL™ Clearinghouse — AI Training Data Revenue Engine
 *
 * Publishers register content. AI crawlers pay per fetch.
 * 70% flows to publisher wallet, 30% to SML platform.
 * Tracks crawl traffic by AI company (OpenAI, Anthropic, Google, Meta).
 * RLUSD settlement via XRPL on configurable interval.
 *
 * (c) Script Master Labs LLC
 */

"use strict";

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Known AI crawler user-agent signatures (from public bot documentation)
// ---------------------------------------------------------------------------
const AI_COMPANY_SIGNATURES = {
  openai:    [/GPTBot/i, /ChatGPT-User/i, /OAI-SearchBot/i],
  anthropic: [/ClaudeBot/i, /Claude-Web/i, /Anthropic/i],
  google:    [/Google-Extended/i, /Googlebot-Image/i, /GoogleOther/i, /Gemini/i],
  meta:      [/FacebookBot/i, /facebookexternalhit/i, /Meta-ExternalAgent/i],
  apple:     [/Applebot/i, /Applebot-Extended/i],
  amazon:    [/Amazonbot/i],
  microsoft: [/bingbot/i, /BingPreview/i],
  perplexity:[/PerplexityBot/i],
  cohere:    [/cohere-ai/i],
  bytedance: [/Bytespider/i],
  generic_ai:[/CCBot/i, /DataForSeoBot/i, /ImagesiftBot/i, /magpie-crawler/i],
};

// ---------------------------------------------------------------------------
// In-memory stores (reset on restart — use external DB for production persistence)
// ---------------------------------------------------------------------------
const _publishers = new Map();   // publisherId → PublisherRecord
const _sessions   = new Map();   // sessionToken → { publisherId, createdAt }
const _ledger     = [];          // [{ts, publisherId, companyKey, url, amountUSDC, paidToPublisher, paidToSml}]

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------
const DEFAULTS = {
  publisherShareBps: 7000,   // 70% to publisher (in basis points)
  platformShareBps:  3000,   // 30% to SML
  settlementCurrency: "RLUSD",
  settlementRail: "xrp",
  maxPublishers: 10_000,
  ledgerMaxEntries: 100_000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectAICompany(userAgent = "") {
  if (!userAgent) return null;
  for (const [company, patterns] of Object.entries(AI_COMPANY_SIGNATURES)) {
    for (const re of patterns) {
      if (re.test(userAgent)) return company;
    }
  }
  return null;
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function now() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Publisher Registry
// ---------------------------------------------------------------------------

/**
 * Register a publisher and their XRPL wallet for revenue share.
 * @param {object} opts
 * @param {string} opts.name        - Human name for the publisher
 * @param {string} opts.xrplWallet  - XRPL r-address to receive RLUSD
 * @param {string[]} opts.domains   - Domains this publisher owns (e.g. ["example.com"])
 * @param {string} [opts.email]     - Contact email (stored hashed)
 * @returns {{ publisherId: string, apiToken: string }}
 */
function registerPublisher({ name, xrplWallet, domains = [], email } = {}) {
  if (!name || typeof name !== "string" || name.length > 128) {
    throw new Error("publisher name required (max 128 chars)");
  }
  if (!xrplWallet || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(xrplWallet)) {
    throw new Error("valid XRPL r-address required for xrplWallet");
  }
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error("at least one domain required");
  }
  if (_publishers.size >= DEFAULTS.maxPublishers) {
    throw new Error("publisher registry at capacity");
  }

  const publisherId = crypto.randomUUID();
  const apiToken    = generateToken();
  const emailHash   = email
    ? crypto.createHash("sha256").update(email.toLowerCase().trim()).digest("hex")
    : null;

  _publishers.set(publisherId, {
    publisherId,
    name,
    xrplWallet,
    domains: domains.map(d => d.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]),
    emailHash,
    registeredAt: now(),
    totalEarnedUSDC: 0,
    totalFetchesBilled: 0,
    pendingSettlementUSDC: 0,
    lastSettledAt: null,
    crawlStats: {},   // { companyKey: { fetches, earnedUSDC } }
  });

  _sessions.set(apiToken, { publisherId, createdAt: now() });

  return { publisherId, apiToken };
}

/**
 * Look up publisher by API token (for dashboard access).
 */
function getPublisherByToken(apiToken) {
  const session = _sessions.get(apiToken);
  if (!session) return null;
  return _publishers.get(session.publisherId) || null;
}

/**
 * Look up which publisher owns a given domain.
 */
function getPublisherByDomain(domain) {
  const normalized = domain.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
  for (const pub of _publishers.values()) {
    for (const d of pub.domains) {
      const nd = d.replace(/^www\./, "");
      if (nd === normalized || normalized.endsWith("." + nd)) {
        return pub;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Revenue Recording
// ---------------------------------------------------------------------------

/**
 * Record a billable AI crawl event and credit the publisher's pending balance.
 * @param {object} opts
 * @param {string} opts.domain       - Domain that was crawled
 * @param {string} opts.url          - Full URL fetched
 * @param {string} opts.userAgent    - Crawler user-agent string
 * @param {number} opts.amountUSDC   - Amount paid by the crawler (in USDC)
 * @returns {{ credited: boolean, publisherShare: number, platformShare: number, company: string|null }}
 */
function recordCrawl({ domain, url, userAgent, amountUSDC } = {}) {
  if (!amountUSDC || amountUSDC <= 0) {
    return { credited: false, reason: "no payment amount" };
  }

  const company = detectAICompany(userAgent);
  const publisher = getPublisherByDomain(domain || "");

  const publisherShare = amountUSDC * (DEFAULTS.publisherShareBps / 10_000);
  const platformShare  = amountUSDC * (DEFAULTS.platformShareBps  / 10_000);

  const entry = {
    ts: now(),
    domain: domain || "",
    url: url || "",
    userAgent: userAgent || "",
    company,
    amountUSDC,
    publisherShare,
    platformShare,
    publisherId: publisher ? publisher.publisherId : null,
    settled: false,
  };

  if (_ledger.length >= DEFAULTS.ledgerMaxEntries) {
    _ledger.shift();  // evict oldest
  }
  _ledger.push(entry);

  if (publisher) {
    publisher.totalFetchesBilled += 1;
    publisher.totalEarnedUSDC    += publisherShare;
    publisher.pendingSettlementUSDC += publisherShare;

    if (!publisher.crawlStats[company || "unknown"]) {
      publisher.crawlStats[company || "unknown"] = { fetches: 0, earnedUSDC: 0 };
    }
    publisher.crawlStats[company || "unknown"].fetches    += 1;
    publisher.crawlStats[company || "unknown"].earnedUSDC += publisherShare;
  }

  return {
    credited: !!publisher,
    publisherShare: +publisherShare.toFixed(6),
    platformShare:  +platformShare.toFixed(6),
    company,
    publisherId: publisher ? publisher.publisherId : null,
  };
}

// ---------------------------------------------------------------------------
// Settlement Queue
// ---------------------------------------------------------------------------

/**
 * Return all publishers with pending balances above minThreshold.
 * The actual XRPL transfer is orchestrated by the settlement runner
 * (external process reads this queue and submits RLUSD transactions).
 */
function getSettlementQueue(minThresholdUSDC = 0.10) {
  const queue = [];
  for (const pub of _publishers.values()) {
    if (pub.pendingSettlementUSDC >= minThresholdUSDC) {
      queue.push({
        publisherId:  pub.publisherId,
        name:         pub.name,
        xrplWallet:   pub.xrplWallet,
        amountRLUSD:  +pub.pendingSettlementUSDC.toFixed(6),
        currency:     DEFAULTS.settlementCurrency,
        rail:         DEFAULTS.settlementRail,
      });
    }
  }
  return queue;
}

/**
 * Mark publisher's pending balance as settled (called after XRPL tx confirms).
 */
function markSettled(publisherId, amountRLUSD, txHash) {
  const pub = _publishers.get(publisherId);
  if (!pub) throw new Error(`Publisher ${publisherId} not found`);
  pub.pendingSettlementUSDC = Math.max(0, pub.pendingSettlementUSDC - amountRLUSD);
  pub.lastSettledAt = now();

  // Mark ledger entries as settled
  for (const entry of _ledger) {
    if (entry.publisherId === publisherId && !entry.settled) {
      entry.settled = true;
      entry.txHash  = txHash;
    }
  }
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * Global crawl stats across all publishers — useful for the dashboard.
 */
function getGlobalStats() {
  const byCompany = {};
  let totalFetches = 0;
  let totalRevenue = 0;
  let totalPublisherRevenue = 0;
  let totalPlatformRevenue  = 0;

  for (const entry of _ledger) {
    const key = entry.company || "unknown";
    if (!byCompany[key]) byCompany[key] = { fetches: 0, revenue: 0 };
    byCompany[key].fetches  += 1;
    byCompany[key].revenue  += entry.amountUSDC;
    totalFetches             += 1;
    totalRevenue             += entry.amountUSDC;
    totalPublisherRevenue    += entry.publisherShare;
    totalPlatformRevenue     += entry.platformShare;
  }

  return {
    totalFetches,
    totalRevenue:          +totalRevenue.toFixed(6),
    totalPublisherRevenue: +totalPublisherRevenue.toFixed(6),
    totalPlatformRevenue:  +totalPlatformRevenue.toFixed(6),
    publisherCount:        _publishers.size,
    revenueShareBps:       { publisher: DEFAULTS.publisherShareBps, platform: DEFAULTS.platformShareBps },
    byCompany,
    settlementCurrency:    DEFAULTS.settlementCurrency,
  };
}

/**
 * Publisher dashboard data (returned to authenticated publisher).
 */
function getPublisherDashboard(publisherId) {
  const pub = _publishers.get(publisherId);
  if (!pub) return null;
  return {
    publisherId:           pub.publisherId,
    name:                  pub.name,
    xrplWallet:            pub.xrplWallet,
    domains:               pub.domains,
    registeredAt:          pub.registeredAt,
    totalFetchesBilled:    pub.totalFetchesBilled,
    totalEarnedUSDC:       +pub.totalEarnedUSDC.toFixed(6),
    pendingSettlementUSDC: +pub.pendingSettlementUSDC.toFixed(6),
    lastSettledAt:         pub.lastSettledAt,
    crawlStats:            pub.crawlStats,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  registerPublisher,
  getPublisherByToken,
  getPublisherByDomain,
  recordCrawl,
  getSettlementQueue,
  markSettled,
  getGlobalStats,
  getPublisherDashboard,
  detectAICompany,
  AI_COMPANY_SIGNATURES,
};
