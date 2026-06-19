/**
 * AP2 mandate verification tests — uses real ECDSA P-256 keys + JCS canonicalization
 */
const crypto = require("crypto");
const { verifyMandate, jcsCanonicalize, verifyVcSignature, mandateFromRequest } = require("../ap2.js");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✔ " + name); }
  else { fail++; console.log("  ✘ " + name + " " + extra); }
};

// Generate a P-256 keypair to act as the trusted issuer (user's wallet / AP2 client)
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pubPem = publicKey.export({ type: "spki", format: "pem" });
const KEY_ID = "did:example:issuer#key-1";

function signVc(vc) {
  const { proof, ...unsigned } = vc;
  const canonical = jcsCanonicalize(unsigned);
  const signer = crypto.createSign("SHA256");
  signer.update(canonical);
  signer.end();
  const sig = signer.sign(privateKey).toString("base64");
  return { ...unsigned, proof: { type: "EcdsaSecp256r1Signature2019", verificationMethod: KEY_ID, proofValue: sig } };
}

console.log("AP2 MANDATE VERIFICATION TESTS\n");

// JCS determinism
check("JCS sorts keys deterministically",
  jcsCanonicalize({ b: 1, a: 2 }) === '{"a":2,"b":1}');
check("JCS handles nested + arrays",
  jcsCanonicalize({ z: [3, 1], a: { y: 1, x: 2 } }) === '{"a":{"x":2,"y":1},"z":[3,1]}');

// Build a valid intent mandate: max $0.10, allows our resource, not expired
const future = new Date(Date.now() + 3600_000).toISOString();
const intent = signVc({
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  type: ["VerifiableCredential", "IntentMandate"],
  issuer: KEY_ID,
  expirationDate: future,
  credentialSubject: {
    intent: "Fetch trading signals from CRAWLTOLL feeds",
    maxPrice: "0.10",
    allowedResources: ["crawltoll.onrender.com"],
  },
});

// Signature round-trips
check("Valid VC signature verifies", verifyVcSignature(intent, pubPem).ok);

// Tampered VC fails
const tampered = JSON.parse(JSON.stringify(intent));
tampered.credentialSubject.maxPrice = "999.00";
check("Tampered VC fails signature", !verifyVcSignature(tampered, pubPem).ok);

// Full mandate verification — within scope
let r = verifyMandate({ intent }, {
  resource: "https://crawltoll.onrender.com/feed/squeeze",
  amountAtomicUSDC: 5000, // 0.005 USDC, under 0.10 cap
  payTo: "0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700",
  trustedIssuers: { [KEY_ID]: pubPem },
});
check("Valid mandate within scope passes", r.valid, JSON.stringify(r.reason));
check("  → price cap check passed", r.checks.within_price_cap);
check("  → resource allowed check passed", r.checks.merchant_allowed);
check("  → intent signature verified", r.checks.intent_signature);

// Over the price cap → reject
r = verifyMandate({ intent }, {
  resource: "https://crawltoll.onrender.com/feed/firehose",
  amountAtomicUSDC: 200000, // 0.20 USDC, OVER 0.10 cap
  payTo: "0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700",
  trustedIssuers: { [KEY_ID]: pubPem },
});
check("Over-cap mandate rejected", !r.valid);
check("  → reason names price cap", String(r.reason).includes("within_price_cap"));

// Expired intent → reject
const expired = signVc({
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  type: ["VerifiableCredential", "IntentMandate"],
  issuer: KEY_ID,
  expirationDate: new Date(Date.now() - 1000).toISOString(),
  credentialSubject: { intent: "old", maxPrice: "1.00" },
});
r = verifyMandate({ intent: expired }, {
  amountAtomicUSDC: 5000, trustedIssuers: { [KEY_ID]: pubPem },
});
check("Expired mandate rejected", !r.valid);

// Wrong merchant → reject
const otherMerchant = signVc({
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  type: ["VerifiableCredential", "IntentMandate"],
  issuer: KEY_ID, expirationDate: future,
  credentialSubject: { intent: "x", maxPrice: "1.00", allowedResources: ["someoneelse.com"] },
});
r = verifyMandate({ intent: otherMerchant }, {
  resource: "https://crawltoll.onrender.com/feed/squeeze",
  amountAtomicUSDC: 5000, payTo: "0xZZZ", trustedIssuers: { [KEY_ID]: pubPem },
});
check("Wrong-merchant mandate rejected", !r.valid);

// No mandate → flagged, not valid
r = verifyMandate(null, {});
check("Missing mandate handled", !r.valid && r.reason === "no_mandate");

// Cart mandate amount binding
const cart = signVc({
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  type: ["VerifiableCredential", "CartMandate"],
  issuer: KEY_ID, expirationDate: future,
  credentialSubject: { total: "0.005", items: [{ sku: "feed/squeeze", price: "0.005" }] },
});
r = verifyMandate({ intent, cart }, {
  resource: "https://crawltoll.onrender.com/feed/squeeze",
  amountAtomicUSDC: 5000, payTo: "0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700",
  trustedIssuers: { [KEY_ID]: pubPem },
});
check("Intent+Cart bundle valid, amount matches", r.valid && r.checks.cart_amount_matches, JSON.stringify(r.reason));

// header parsing
const fakeReq = { headers: { "x-ap2-mandate": Buffer.from(JSON.stringify({ intent })).toString("base64") } };
const parsed = mandateFromRequest(fakeReq);
check("Mandate parsed from X-AP2-MANDATE header", parsed && parsed.intent);

// Prototype pollution guard — __proto__ as a JSON key is an own-property in V8 (safe),
// but constructor.prototype injection must be blocked.
const constructorPayload = Buffer.from(JSON.stringify({
  constructor: { prototype: { admin: true } }, intent
})).toString("base64");
const poisoned = mandateFromRequest({ headers: { "x-ap2-mandate": constructorPayload } });
check("constructor.prototype injection in mandate rejected (returns null)", poisoned === null);
check("Object.prototype.admin not set after injection attempt", ({}).admin === undefined);

// Header size limit — very large header must be rejected
const hugeReq = { headers: { "x-ap2-mandate": "A".repeat(70000) } };
check("Oversized mandate header rejected (returns null)", mandateFromRequest(hugeReq) === null);

// Untrusted issuer — key not in trusted set must fail signature check
r = verifyMandate({ intent }, {
  resource: "https://crawltoll.onrender.com/feed/squeeze",
  amountAtomicUSDC: 5000,
  payTo: "0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700",
  trustedIssuers: { "did:example:other#key-99": pubPem }, // different key ID
});
check("Mandate with unknown key ID rejected when trustedIssuers populated", !r.valid);

// No trusted issuers — signature check skipped, non-sig checks still run
r = verifyMandate({ intent }, {
  resource: "https://crawltoll.onrender.com/feed/squeeze",
  amountAtomicUSDC: 5000,
  payTo: "0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700",
  trustedIssuers: {},
});
check("Mandate valid with no trustedIssuers (sig check skipped)", r.valid);
check("  → intent_signature_skipped flagged", r.checks.intent_signature_skipped === true);
check("  → intent_signature not set (not blocking)", r.checks.intent_signature === undefined);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
