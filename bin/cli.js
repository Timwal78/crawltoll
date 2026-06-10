#!/usr/bin/env node
/**
 * CRAWLTOLL™ CLI — `npx crawltoll init`
 * Generates crawltoll.config.json + llms.txt + agents.json + robots.txt additions
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const NEON = "\x1b[92m", PINK = "\x1b[95m", GOLD = "\x1b[93m", RESET = "\x1b[0m", BOLD = "\x1b[1m";

function banner() {
  console.log(`${NEON}${BOLD}
  ██████ ██████   █████  ██     ██ ██      ████████  ██████  ██      ██      
 ██      ██   ██ ██   ██ ██     ██ ██         ██    ██    ██ ██      ██      
 ██      ██████  ███████ ██  █  ██ ██         ██    ██    ██ ██      ██      
 ██      ██   ██ ██   ██ ██ ███ ██ ██         ██    ██    ██ ██      ██      
  ██████ ██   ██ ██   ██  ███ ███  ███████    ██     ██████  ███████ ███████ 
${RESET}${PINK}  Turn AI scraping into revenue. x402 tolls for the agentic web.${RESET}
${GOLD}  Script Master Labs LLC — BEAST MODE${RESET}
`);
}

async function ask(rl, q, fallback) {
  return new Promise((resolve) => {
    rl.question(`${NEON}?${RESET} ${q} ${fallback ? `(${fallback}) ` : ""}`, (a) => resolve(a.trim() || fallback));
  });
}

async function init() {
  banner();
  const yes = args.includes("--yes") || args.includes("-y");

  let payTo, price, network, domain;

  if (yes) {
    payTo = flag("payto", "0xYOUR_WALLET_ADDRESS");
    price = flag("price", "0.005");
    network = flag("network", "base");
    domain = flag("domain", "example.com");
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    payTo = await ask(rl, "USDC wallet address (Base) to receive tolls:", flag("payto", ""));
    price = await ask(rl, "Price per fetch in USDC:", flag("price", "0.005"));
    network = await ask(rl, "Network [base / base-sepolia]:", flag("network", "base"));
    domain = await ask(rl, "Your domain (for discovery files):", flag("domain", "example.com"));
    rl.close();
  }

  // 1. crawltoll.config.json
  const config = {
    payTo,
    network,
    priceUSDC: price,
    facilitatorUrl: "https://x402.org/facilitator",
    description: `Pay-per-fetch access to ${domain} content via CRAWLTOLL`,
    freePaths: ["/robots.txt", "/llms.txt", "/agents.json", "/.well-known", "/favicon.ico", "/crawltoll"],
    chargeHumans: false,
  };
  fs.writeFileSync("crawltoll.config.json", JSON.stringify(config, null, 2));
  console.log(`${NEON}✔${RESET} crawltoll.config.json`);

  // 2. llms.txt
  const llms = `# ${domain}
# AI/LLM access policy — powered by CRAWLTOLL (x402)

> Content on this site is available to AI agents on a pay-per-fetch basis.
> Protocol: x402 (HTTP 402 Payment Required)
> Payment: USDC on ${network}
> Price: ${price} USDC per fetch
> Pay-to: ${payTo}
> Facilitator: https://x402.org/facilitator

Agents that send a valid X-PAYMENT header receive full content instantly.
Unpaid automated requests receive HTTP 402 with machine-readable payment requirements.
Human visitors browse free.
`;
  fs.writeFileSync("llms.txt", llms);
  console.log(`${NEON}✔${RESET} llms.txt`);

  // 3. agents.json
  const agentsJson = {
    schema_version: "1.0",
    name: domain,
    description: `x402-gated content access for AI agents on ${domain}`,
    payment: {
      protocol: "x402",
      version: 1,
      scheme: "exact",
      network,
      asset: "USDC",
      price_per_fetch: price,
      pay_to: payTo,
      facilitator: "https://x402.org/facilitator",
    },
    endpoints: [
      {
        path: "/*",
        method: "GET",
        price_usdc: price,
        description: "Any content page — pay per fetch",
      },
    ],
    contact: `admin@${domain}`,
  };
  fs.writeFileSync("agents.json", JSON.stringify(agentsJson, null, 2));
  console.log(`${NEON}✔${RESET} agents.json`);

  // 4. robots additions
  const robotsAdd = `# --- CRAWLTOLL: AI crawlers welcome, payment required ---
# See /llms.txt and /agents.json for x402 payment terms
User-agent: GPTBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /
`;
  fs.writeFileSync("robots.crawltoll.txt", robotsAdd);
  console.log(`${NEON}✔${RESET} robots.crawltoll.txt (append to your robots.txt)`);

  console.log(`
${GOLD}${BOLD}WIRE IT UP (Express):${RESET}

  const crawltoll = require("crawltoll");
  app.use(crawltoll());          // reads crawltoll.config.json

${GOLD}${BOLD}TEST IT:${RESET}

  curl -A "GPTBot" https://${domain}/any-page     ${PINK}→ HTTP 402 + payment terms${RESET}
  curl https://${domain}/any-page                  ${PINK}→ humans pass free${RESET}

${NEON}${BOLD}Toll booth is live. Every bot fetch = USDC in your wallet.${RESET}
`);
}

function stats() {
  const { getStats } = require("./index.js");
  const s = getStats(flag("ledger"));
  banner();
  console.log(`${GOLD}${BOLD}REVENUE STATS${RESET}
  Paid fetches:   ${NEON}${s.paidFetches}${RESET}
  402 challenges: ${s.challenges}
  Revenue (USDC): ${NEON}$${s.revenueUSDC}${RESET}
`);
}

if (cmd === "init") init();
else if (cmd === "stats") stats();
else {
  banner();
  console.log(`Usage:
  npx crawltoll init              Interactive setup
  npx crawltoll init -y --payto 0x... --price 0.005 --domain yoursite.com
  npx crawltoll stats             Show revenue from ledger
`);
}
