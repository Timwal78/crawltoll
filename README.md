# CRAWLTOLL™

**Turn AI scraping into revenue.** One-command x402 (HTTP-402) paywall: AI crawlers pay USDC per fetch, humans browse free.

By [Script Master Labs LLC](https://www.scriptmasterlabs.com) — built for the agentic web.

**AP2-compatible:** CRAWLTOLL settles via x402 — the stablecoin rail of Google's Agent Payments Protocol (A2A x402 extension, built with Coinbase). Coinbase's own AP2 launch cites *per-crawl fees* and *paying for data crawls* as flagship x402 use cases — that's exactly what CRAWLTOLL does.

## How it works
1. Your site gets a 3-line middleware
2. Bot/agent traffic hits HTTP 402 with machine-readable x402 payment terms (USDC on Base)
3. Agent sends `X-PAYMENT` header → verified + settled via facilitator → content unlocks instantly
4. Every fetch = USDC in your wallet. Revenue ledger + stats built in.

## Quick start
```bash
npx crawltoll init
```
Generates `crawltoll.config.json`, `llms.txt`, `agents.json`, and robots.txt additions.

```js
const crawltoll = require("crawltoll");
app.use(crawltoll()); // Express/Connect — reads crawltoll.config.json
```

Or run the standalone toll server (Render-ready, `render.yaml` included):
```bash
node server.js
```

## Test it
```bash
curl -A "GPTBot" https://yoursite.com/page   # → 402 + payment terms
curl https://yoursite.com/page                # → humans free
npx crawltoll stats                           # → revenue
```

## Config (`crawltoll.config.json`)
| Key | Default | |
|---|---|---|
| `payTo` | — | Your USDC wallet (Base) |
| `network` | `base` | or `base-sepolia` for testing |
| `priceUSDC` | `0.005` | price per fetch |
| `freePaths` | discovery files | always open |
| `chargeHumans` | `false` | flip to gate everything |

## Detected agents
GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Bytespider, CCBot, Amazonbot, Applebot-Extended, Meta, generic bots/scrapers (curl, python-requests, axios, headless browsers), and anything already speaking x402.

MIT © Script Master Labs LLC
