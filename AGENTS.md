# CRAWLTOLL — AI Agent Development Brief

CRAWLTOLL™ is an x402 paywall middleware for Node.js/Express. AI crawlers pay USDC per fetch; human visitors browse free. AP2-native (Google Agent Payments Protocol).

## What This Repo Is

An npm package (`crawltoll`) that wraps `x402-express` with:
- Automatic AI agent detection (User-Agent fingerprinting)
- Per-fetch USDC pricing on Base mainnet / Base Sepolia testnet
- AP2 mandate verification (optional or required mode)
- Free-path allowlist (robots.txt, llms.txt, agents.json, etc.)
- x402 Bazaar discovery metadata for Coinbase CDP indexing

## Repository Layout

```
crawltoll/
├── index.js            — Main export: crawltoll() middleware factory
├── ap2.js              — AP2 (Google Agent Payments Protocol) mandate verifier
├── feed.js             — Optional: streaming data feed helpers
├── bin/cli.js          — CLI: `crawltoll start` for standalone server
├── package.json        — npm package: name="crawltoll"
├── render.yaml         — Render.com deployment config
├── public/
│   ├── llms.txt        — AI access policy (served free, describes payment requirement)
│   ├── agents.json     — Structured agent discovery manifest
│   ├── .well-known-agent.json — Well-known agent metadata
│   ├── robots.txt      — Standard robots control
│   ├── sitemap.xml     — Site map
│   └── index.html      — Landing page
└── test/
    ├── ap2.test.js     — AP2 mandate verification unit tests
    └── smoke.js        — End-to-end smoke test
```

## Key Files

### `index.js`
The middleware factory. `crawltoll(options)` returns an Express middleware.
Key options (see DEFAULTS object in index.js):
- `payTo` — EVM 0x wallet address (USDC recipient)
- `network` — `"base"` or `"base-sepolia"`
- `priceUSDC` — Price per fetch as string (e.g. `"0.005"`)
- `facilitatorUrl` — x402 facilitator (default: x402.org)
- `freePaths` — Array of paths always served free (robots.txt, llms.txt, etc.)
- `chargeHumans` — Boolean, default false (humans browse free)
- `ap2Mode` — `"off"` | `"optional"` | `"required"`

### `ap2.js`
Implements AP2 (Google Agent Payments Protocol) mandate verification.
- `verifyMandate(mandate, context)` — verifies W3C VC bundle
- `mandateFromRequest(req)` — extracts mandate from X-AP2-MANDATE header

### `bin/cli.js`
Standalone server mode. Reads env vars: `CRAWLTOLL_PAY_TO`, `CRAWLTOLL_PRICE`, `CRAWLTOLL_PORT`, `CRAWLTOLL_UPSTREAM`.

## AI Bot Detection

`AI_BOT_PATTERNS` in `index.js` is the source of truth for which User-Agents trigger the paywall.
Covers: GPTBot, ClaudeBot, Gemini, PerplexityBot, ByteSpider, CCBot, Cohere, python-requests, axios, curl, headless browsers, and generic bot/crawler/spider patterns.

**To add a new bot pattern**, add to the `AI_BOT_PATTERNS` array in `index.js`:
```js
/newbotname/i,
```

## Payment Flow (what agents see)

1. Agent sends any HTTP request to a protected route
2. CRAWLTOLL detects AI agent via User-Agent (or X-PAYMENT header presence)
3. If no valid X-PAYMENT header: returns HTTP 402 with `application/json+x402` payment requirements
4. Agent pays USDC on Base → sends X-PAYMENT header with settlement proof
5. CRAWLTOLL verifies with facilitator → proxies to upstream → returns content

## Free Paths

These paths are always served without payment (configured in `freePaths` default):
`/robots.txt`, `/llms.txt`, `/agents.json`, `/sitemap.xml`, `/.well-known`, `/favicon.ico`, `/crawltoll`

## Environment Variables (deployed service)

| Variable | Purpose |
|----------|---------|
| `CRAWLTOLL_PAY_TO` | EVM 0x wallet for USDC payments |
| `CRAWLTOLL_PRICE` | Price per fetch in USDC (e.g. "0.005") |
| `CRAWLTOLL_NETWORK` | "base" or "base-sepolia" |
| `CRAWLTOLL_PORT` | Listen port |
| `CRAWLTOLL_UPSTREAM` | Upstream URL to proxy to |
| `X402_FACILITATOR_URL` | Override x402 facilitator URL |
| `X402_BAZAAR_DISCOVERABLE` | "true"/"false" — CDP Bazaar indexing |

## Hard Rules

- **Never hardcode wallet addresses in source** — use env vars for `payTo`
- **Never charge human visitors** — `chargeHumans` must remain `false` by default
- **Free paths must stay free** — `freePaths` list protects agent discovery files; never remove them
- **AP2 mode** must default to `"optional"` — only set `"required"` when all callers support AP2
- **No demo/simulated payment data** — every settlement goes through the real x402 facilitator

## Testing

```bash
node test/smoke.js       # End-to-end smoke test
node test/ap2.test.js    # AP2 mandate tests
```

## Deployment

`render.yaml` is the source of truth for the deployed service. The package is also available on npm as `crawltoll`.

## Built by ScriptMasterLabs (SDVOSB)
GitHub: https://github.com/Timwal78/crawltoll
Ecosystem: https://www.scriptmasterlabs.com
