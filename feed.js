/**
 * CRAWLTOLL™ — REAL INVENTORY FEED
 * Toll-gated signal endpoints that serve fresh squeeze/options intelligence.
 * This is what AI agents actually pay 0.005+ USDC to fetch.
 *
 * Upstream: live SqueezeOS scanner (squeezeos-api.onrender.com)
 * Tiers:  /feed/squeeze  (technical squeeze hits)
 *         /feed/options  (graded 0DTE-14D options picks)
 *         /feed/universe (full market scan snapshot)
 *         /feed/firehose (everything, premium tier)
 *
 * (c) Script Master Labs LLC — BEAST MODE
 */

const UPSTREAM = process.env.SML_UPSTREAM || "https://squeezeos-api.onrender.com/api/market/scan";
const CACHE_TTL_MS = 15_000; // 15s — fresh enough for agents, light on upstream

let _cache = { ts: 0, data: null };

async function pullUpstream() {
  const now = Date.now();
  if (_cache.data && now - _cache.ts < CACHE_TTL_MS) return _cache.data;
  try {
    const res = await fetch(UPSTREAM, { headers: { "User-Agent": "crawltoll-feed/1.0" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const data = await res.json();
    _cache = { ts: now, data };
    return data;
  } catch (e) {
    // serve last good cache if upstream blips
    if (_cache.data) return _cache.data;
    return { status: "upstream_unavailable", quotes: {}, options: [], scan_count: 0, universe_size: 0, last_update: 0 };
  }
}

function meta(scan) {
  return {
    generated_at: new Date().toISOString(),
    upstream_scan_count: scan.scan_count || 0,
    universe_size: scan.universe_size || 0,
    last_scan_unix: scan.last_update || 0,
    market_open: (scan.universe_size || 0) > 0,
    provider: "Script Master Labs — CRAWLTOLL feed",
    payment: "x402 / HTTP-402 · USDC on Base",
  };
}

// Squeeze hits — technical squeeze signals (score-ranked)
function squeezeFeed(scan) {
  const quotes = scan.quotes || {};
  const hits = Object.entries(quotes)
    .map(([sym, q]) => ({
      symbol: sym,
      price: q.price ?? q.last ?? null,
      change_pct: q.changePct ?? q.change_pct ?? null,
      volume_ratio: q.volRatio ?? q.vol_ratio ?? null,
      squeeze_score: q.squeeze_score ?? q.score ?? null,
    }))
    .filter((x) => x.squeeze_score != null)
    .sort((a, b) => (b.squeeze_score || 0) - (a.squeeze_score || 0))
    .slice(0, 50);
  return { meta: meta(scan), feed: "squeeze", count: hits.length, signals: hits };
}

// Options picks — graded contracts
function optionsFeed(scan) {
  const picks = (scan.options || [])
    .map((p) => ({
      symbol: p.symbol,
      type: p.type,
      strike: p.strike,
      expiration: p.expiration,
      grade: p.grade,
      score: p.score,
      mid: p.mid,
      dte: p.dte,
      stock_price: p.stock_price,
    }))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 50);
  return { meta: meta(scan), feed: "options", count: picks.length, signals: picks };
}

function universeFeed(scan) {
  const quotes = scan.quotes || {};
  return {
    meta: meta(scan),
    feed: "universe",
    count: Object.keys(quotes).length,
    quotes,
  };
}

async function firehoseFeed() {
  const scan = await pullUpstream();
  return {
    meta: meta(scan),
    feed: "firehose",
    squeeze: squeezeFeed(scan).signals,
    options: optionsFeed(scan).signals,
    universe_size: scan.universe_size || 0,
  };
}

// Router: maps a path to a feed builder. Returns null if not a feed path.
async function serveFeed(path) {
  const scan = await pullUpstream();
  switch (path) {
    case "/feed/squeeze":  return squeezeFeed(scan);
    case "/feed/options":  return optionsFeed(scan);
    case "/feed/universe": return universeFeed(scan);
    case "/feed/firehose": return await firehoseFeed();
    case "/feed":          return {
      meta: meta(scan),
      feed: "index",
      available: {
        "/feed/squeeze":  "Technical squeeze hits, score-ranked. 0.005 USDC/fetch.",
        "/feed/options":  "Graded 0DTE–14D options picks. 0.01 USDC/fetch.",
        "/feed/universe": "Full market scan snapshot. 0.02 USDC/fetch.",
        "/feed/firehose": "Everything, single pull. 0.05 USDC/fetch.",
      },
      note: "All endpoints are x402-gated. Send X-PAYMENT (USDC on Base) to receive data.",
    };
    default: return null;
  }
}

// Per-path pricing (atomic USDC handled by middleware via priceUSDC)
const FEED_PRICING = {
  "/feed/squeeze":  "0.005",
  "/feed/options":  "0.01",
  "/feed/universe": "0.02",
  "/feed/firehose": "0.05",
};

module.exports = { serveFeed, FEED_PRICING, pullUpstream };
