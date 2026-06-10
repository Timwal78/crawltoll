/**
 * CRAWLTOLL smoke test — no external deps, uses raw http
 * Verifies: bot gets 402 + valid x402 body, human passes free, free paths open
 */
const http = require("http");
const crawltoll = require("../index.js");

// Minimal Express-like adapter over raw http
function makeApp(middleware, handler) {
  return http.createServer((req, res) => {
    // shim express-isms
    req.path = req.url.split("?")[0];
    req.originalUrl = req.url;
    req.protocol = "http";
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = (k, v) => { res.setHeader(k, v); return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    middleware(req, res, () => handler(req, res));
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

(async () => {
  const mw = crawltoll({
    payTo: "0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700",
    network: "base",
    priceUSDC: "0.005",
    ledgerFile: "/tmp/crawltoll-test-ledger.jsonl",
  });

  const server = makeApp(mw, (req, res) => {
    res.statusCode = 200;
    res.end("PREMIUM CONTENT");
  });

  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  let pass = 0, fail = 0;
  const check = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  ✔ ${name}`); }
    else { fail++; console.log(`  ✘ ${name} ${extra}`); }
  };

  console.log("CRAWLTOLL SMOKE TEST\n");

  // 1. Bot (GPTBot) → 402
  const bot = await get(port, "/article", { "User-Agent": "GPTBot/1.0" });
  check("GPTBot gets HTTP 402", bot.status === 402, `(got ${bot.status})`);
  const body = JSON.parse(bot.body);
  check("402 body has x402Version", body.x402Version === 1);
  check("402 body has accepts[]", Array.isArray(body.accepts) && body.accepts.length === 1);
  const req0 = body.accepts[0];
  check("scheme=exact, network=base", req0.scheme === "exact" && req0.network === "base");
  check("payTo wallet correct", req0.payTo === "0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700");
  check("0.005 USDC → 5000 atomic", req0.maxAmountRequired === "5000");
  check("USDC asset on Base", req0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

  // 2. ClaudeBot → 402
  const cb = await get(port, "/page", { "User-Agent": "ClaudeBot" });
  check("ClaudeBot gets HTTP 402", cb.status === 402);

  // 3. Human browser → free pass
  const human = await get(port, "/article", {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  check("Human gets 200 + content", human.status === 200 && human.body === "PREMIUM CONTENT", `(got ${human.status})`);

  // 4. Free path stays open even for bots
  const free = await get(port, "/llms.txt", { "User-Agent": "GPTBot/1.0" });
  check("llms.txt free for bots", free.status === 200);

  // 5. curl (generic automation) → 402
  const curl = await get(port, "/data", { "User-Agent": "curl/8.4.0" });
  check("curl gets HTTP 402", curl.status === 402);

  // 6. Stats from ledger
  const stats = crawltoll.getStats("/tmp/crawltoll-test-ledger.jsonl");
  check("Ledger logged challenges", stats.challenges >= 3, `(got ${stats.challenges})`);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
