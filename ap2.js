/**
 * CRAWLTOLL™ — AP2 MANDATE VERIFICATION
 * Validates Google Agent Payments Protocol (AP2) Mandates before honoring agent payments.
 *
 * AP2 represents every agent purchase as signed Verifiable Digital Credentials (Mandates):
 *   - Intent Mandate  : what the user authorized the agent to do (scope, max price, TTL, allowed merchants)
 *   - Cart Mandate    : the exact items/price/total the agent assembled, bound to the Intent
 *   - Payment Mandate : the charge the rail will settle, bound to the Cart
 *
 * Mandates are W3C Verifiable Credentials (JSON-LD), signed with ECDSA P-256 + SHA-256,
 * canonicalized via JSON Canonicalization Scheme (JCS, RFC 8785).
 * Spec: https://ap2-protocol.org/specification/
 *
 * This module is rail-aware: when an AP2 Mandate accompanies an x402 payment, CRAWLTOLL
 * verifies the agent was actually authorized for this resource + amount, not just that
 * a wallet paid. That is the difference between "x402-compatible" and "AP2-native".
 *
 * (c) Script Master Labs LLC — BEAST MODE
 */

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// JSON Canonicalization Scheme (JCS, RFC 8785) — deterministic serialization
// ---------------------------------------------------------------------------
function jcsCanonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(jcsCanonicalize).join(",") + "]";
  }
  // Objects: keys sorted by UTF-16 code unit (JSON.stringify default for ASCII keys)
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcsCanonicalize(value[k])).join(",") + "}";
}

// ---------------------------------------------------------------------------
// Signature verification (ECDSA P-256 / SHA-256 over JCS-canonicalized claims)
// ---------------------------------------------------------------------------
function verifyVcSignature(vc, publicKeyPem) {
  try {
    const proof = vc.proof;
    if (!proof || !proof.proofValue) return { ok: false, reason: "missing_proof" };

    // Reconstruct the signed payload: the credential minus the proof block
    const { proof: _omit, ...unsigned } = vc;
    const canonical = jcsCanonicalize(unsigned);

    const sig = Buffer.from(proof.proofValue, "base64");
    const verifier = crypto.createVerify("SHA256");
    verifier.update(canonical);
    verifier.end();

    const ok = verifier.verify(publicKeyPem, sig);
    return { ok, reason: ok ? "valid" : "bad_signature" };
  } catch (e) {
    return { ok: false, reason: "verify_error:" + String(e.message).slice(0, 60) };
  }
}

// ---------------------------------------------------------------------------
// Mandate field/TTL/scope checks
// ---------------------------------------------------------------------------
function notExpired(vc) {
  const exp = vc.expirationDate || (vc.credentialSubject && vc.credentialSubject.ttl);
  if (!exp) return true; // no expiry declared
  const t = typeof exp === "number" ? exp * 1000 : Date.parse(exp);
  return Number.isFinite(t) ? Date.now() < t : true;
}

function within(amountAtomicUSDC, intentMaxUSDC) {
  if (intentMaxUSDC == null) return true;
  const max = Math.round(parseFloat(intentMaxUSDC) * 1e6);
  return amountAtomicUSDC <= max;
}

// ---------------------------------------------------------------------------
// Top-level: verify an AP2 mandate bundle against this request
// mandate = { intent, cart, payment }  (each a VC) — any subset accepted
// ctx = { resource, amountAtomicUSDC, payTo, trustedIssuers: {did|keyId: publicKeyPem} }
// ---------------------------------------------------------------------------
function verifyMandate(mandate, ctx = {}) {
  const result = { ap2: true, valid: false, checks: {}, reason: null };
  if (!mandate || typeof mandate !== "object") {
    result.reason = "no_mandate";
    return result;
  }

  const { intent, cart, payment } = mandate;
  const trusted = ctx.trustedIssuers || {};

  // 1. Intent Mandate — scope, TTL, price ceiling
  if (intent) {
    const cs = intent.credentialSubject || {};
    result.checks.intent_present = true;
    result.checks.intent_not_expired = notExpired(intent);

    // price ceiling
    const maxPrice = cs.maxPrice ?? cs.constraints?.max_price ?? cs.hardConstraints?.maxPrice;
    result.checks.within_price_cap = within(ctx.amountAtomicUSDC || 0, maxPrice);

    // allowed merchants / resources (if declared, ours must be in the set)
    const allowed = cs.allowedMerchants || cs.allowed_merchants || cs.allowedResources;
    if (Array.isArray(allowed) && allowed.length) {
      result.checks.merchant_allowed =
        allowed.some((a) => ctx.payTo && a && String(a).toLowerCase() === String(ctx.payTo).toLowerCase()) ||
        allowed.some((a) => ctx.resource && String(ctx.resource).includes(String(a)));
    } else {
      result.checks.merchant_allowed = true; // open intent
    }

    // signature (if we have the issuer key)
    const keyRef = intent.proof?.verificationMethod || intent.issuer;
    if (trusted[keyRef]) {
      result.checks.intent_signature = verifyVcSignature(intent, trusted[keyRef]).ok;
    }
  }

  // 2. Cart Mandate — bound to Intent, locks amount
  if (cart) {
    const cs = cart.credentialSubject || {};
    result.checks.cart_present = true;
    result.checks.cart_not_expired = notExpired(cart);
    // cart total should match what we're charging
    const total = cs.total ?? cs.amount ?? cs.cartTotal;
    if (total != null) {
      const totalAtomic = Math.round(parseFloat(total) * 1e6);
      result.checks.cart_amount_matches = Math.abs(totalAtomic - (ctx.amountAtomicUSDC || 0)) <= 1;
    }
    const keyRef = cart.proof?.verificationMethod || cart.issuer;
    if (trusted[keyRef]) {
      result.checks.cart_signature = verifyVcSignature(cart, trusted[keyRef]).ok;
    }
  }

  // 3. Payment Mandate — the charge itself
  if (payment) {
    result.checks.payment_present = true;
    result.checks.payment_not_expired = notExpired(payment);
    const keyRef = payment.proof?.verificationMethod || payment.issuer;
    if (trusted[keyRef]) {
      result.checks.payment_signature = verifyVcSignature(payment, trusted[keyRef]).ok;
    }
  }

  // Decision: every check that ran must be true; at least an Intent must be present
  const ran = Object.values(result.checks);
  const allPass = ran.length > 0 && ran.every(Boolean);
  result.valid = Boolean(intent) && allPass;
  if (!result.valid) {
    const failed = Object.entries(result.checks).filter(([, v]) => !v).map(([k]) => k);
    result.reason = failed.length ? "failed:" + failed.join(",") : "no_intent_mandate";
  } else {
    result.reason = "mandate_valid";
  }
  return result;
}

// ---------------------------------------------------------------------------
// Express helper: pull mandate from X-AP2-MANDATE header (base64 JSON) and verify.
// Returns null if no mandate present (caller decides whether AP2 is required).
// ---------------------------------------------------------------------------
function mandateFromRequest(req) {
  const hdr = req.headers["x-ap2-mandate"] || req.headers["x-ap2-mandates"];
  if (!hdr) return null;
  try {
    const json = Buffer.from(hdr, "base64").toString("utf8");
    return JSON.parse(json);
  } catch (_) {
    try { return JSON.parse(hdr); } catch (__) { return null; }
  }
}

module.exports = {
  verifyMandate,
  mandateFromRequest,
  verifyVcSignature,
  jcsCanonicalize,
};
