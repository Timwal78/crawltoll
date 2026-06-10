# CRAWLTOLL™

**Turn AI scraping into revenue.** One-command x402 (HTTP-402) paywall: AI crawlers pay USDC per fetch, humans browse free.

By [Script Master Labs LLC](https://www.scriptmasterlabs.com) — built for the agentic web.

**AP2-compatible:** CRAWLTOLL settles via x402 — the stablecoin rail of Google's Agent Payments Protocol (A2A x402 extension, built with Coinbase). Coinbase's own AP2 launch cites *per-crawl fees* and *paying for data crawls* as flagship x402 use cases — that's exactly what CRAWLTOLL does.


## AP2 Mandate Verification (v1.1.0)

CRAWLTOLL is **AP2-native** — it verifies Google Agent Payments Protocol mandates, not just x402 payments.

When an AI agent (e.g. Gemini Spark via AP2/Universal Cart) presents an `X-AP2-MANDATE` header, CRAWLTOLL validates the W3C Verifiable Credential bundle before honoring payment:

- **Intent Mandate** — was the agent authorized for this resource, within this price cap, before this TTL?
- **Cart Mandate** — does the locked total match what's being charged?
- **Payment Mandate** — is the charge itself signed?

Signatures verified via ECDSA P-256 / SHA-256 over JCS-canonicalized claims (RFC 8785), per the [AP2 spec](https://ap2-protocol.org/specification/).

```js
const crawltoll = require("crawltoll");
app.use(crawltoll({
  ap2Mode: "required",                    // "off" | "optional" | "required"
  ap2TrustedIssuers: { "did:...#key": pubKeyPem },
}));
```

This is the difference between *x402-compatible* (a wallet paid) and *AP2-native* (the agent proved it was authorized to pay). Settlement still rides x402 — USDC on Base.

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
