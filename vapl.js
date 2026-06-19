/**
 * VAPL — Verifiable Agent Provenance Layer for Crawltoll
 *
 * Thin Node.js implementation using only built-in `crypto` (Node ≥ 18).
 * Issues W3C VC 2.0 InteractionCredentials signed with Ed25519 (eddsa-vapl-2024).
 * No npm deps added.
 *
 * Security note: the soul file contains a private key. Set VAPL_SOUL_FILE to a
 * path on a persistent volume with file mode 0600. Never commit the soul file.
 * Default path is /tmp (ephemeral) — acceptable for development only.
 */

"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── Base58btc ─────────────────────────────────────────────────────────────────
const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58Encode(buf) {
  if (!buf || buf.length === 0) return "1";
  let leading = 0;
  for (const b of buf) { if (b !== 0) break; leading++; }
  const hexStr = buf.toString("hex");
  if (!hexStr) return "1".repeat(leading);
  let n = BigInt("0x" + hexStr);
  const chars = [];
  while (n > 0n) { chars.push(B58_ALPHA[Number(n % 58n)]); n /= 58n; }
  return "1".repeat(leading) + chars.reverse().join("");
}

// ── DID:key ───────────────────────────────────────────────────────────────────
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);

function pubKeyToDid(pubBuf) {
  return `did:key:z${b58Encode(Buffer.concat([ED25519_MULTICODEC, pubBuf]))}`;
}

// ── Soul ──────────────────────────────────────────────────────────────────────
function generateSoul() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pubBuf = publicKey.export({ type: "spki", format: "der" }).slice(-32);
  const privBuf = privateKey.export({ type: "pkcs8", format: "der" }).slice(-32);
  const did = pubKeyToDid(pubBuf);
  const multibase = `z${b58Encode(Buffer.concat([ED25519_MULTICODEC, pubBuf]))}`;
  const keyId = did.slice("did:key:".length);
  return {
    did,
    verificationMethodId: `${did}#${keyId}`,
    publicKeyMultibase: multibase,
    publicKeyBase64url: pubBuf.toString("base64url"),
    privateKeyBase64url: privBuf.toString("base64url"),
    createdAt: new Date().toISOString(),
  };
}

function soulFromDict(d) {
  return {
    did: d.did,
    verificationMethodId: d.verificationMethodId || d.verification_method_id,
    publicKeyMultibase: d.publicKeyMultibase || d.public_key_multibase,
    privateKeyBase64url: d.privateKeyBase64url || d.private_key_base64url,
    createdAt: d.createdAt || d.created_at,
    sign(message) {
      const privBuf = Buffer.from(this.privateKeyBase64url, "base64url");
      const key = crypto.createPrivateKey({ key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        privBuf,
      ]), format: "der", type: "pkcs8" });
      return crypto.sign(null, message, key);
    },
  };
}

// ── Soul manager (singleton) ──────────────────────────────────────────────────
let _soul = null;

function getSoul() {
  if (_soul) return _soul;
  const soulPath = process.env.VAPL_SOUL_FILE || "/tmp/vapl_soul_crawltoll.json";

  if (soulPath.startsWith("/tmp")) {
    console.warn("[VAPL] WARNING: Soul file is in /tmp (ephemeral). Set VAPL_SOUL_FILE to a persistent volume path in production.");
  }

  if (fs.existsSync(soulPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(soulPath, "utf8"));
      // Validate the loaded soul has required fields before trusting it
      if (!raw.did || !raw.privateKeyBase64url) {
        throw new Error("Soul file is missing required fields (did, privateKeyBase64url)");
      }
      _soul = soulFromDict(raw);
      console.log(`[VAPL] Soul loaded: ${_soul.did}`);
      return _soul;
    } catch (e) {
      console.warn("[VAPL] Failed to load soul:", e.message);
      // Fall through to generate a new soul
    }
  }

  const raw = generateSoul();
  try {
    fs.mkdirSync(path.dirname(soulPath), { recursive: true });
    fs.writeFileSync(soulPath, JSON.stringify(raw, null, 2), { mode: 0o600 });
    console.log(`[VAPL] New soul saved: ${raw.did}`);
    console.log(`[VAPL] Soul file permissions set to 0600. Path: ${soulPath}`);
  } catch (e) {
    console.warn("[VAPL] Could not persist soul:", e.message);
  }
  _soul = soulFromDict(raw);
  return _soul;
}

// ── Canonical JSON ────────────────────────────────────────────────────────────
function canonicalJson(obj) {
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(",")}]`;
  if (obj !== null && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(obj);
}

function nonce(n = 16) { return crypto.randomBytes(n).toString("base64url"); }
function nowIso() { return new Date().toISOString().replace("+00:00", "Z"); }

// ── VC issuance ───────────────────────────────────────────────────────────────
function issueInteractionVc(soul, subjectDid, interactionType, resource, outcome, paymentTxHash) {
  const id = `urn:vapl:vc:${soul.did.slice(-8)}:${Date.now()}:${nonce(6)}`;
  const validUntil = new Date(Date.now() + 365 * 86400 * 1000).toISOString();
  const body = {
    "@context": ["https://www.w3.org/ns/credentials/v2", "https://vapl.scriptmasterlabs.com/v1/context.jsonld"],
    id,
    type: ["VerifiableCredential", "InteractionCredential"],
    issuer: soul.did,
    validFrom: nowIso(),
    validUntil,
    credentialSubject: {
      id: subjectDid,
      interaction: {
        type: interactionType,
        resource,
        timestamp: nowIso(),
        outcome,
        nonce: nonce(8),
        ...(paymentTxHash ? { paymentTxHash } : {}),
      },
    },
  };

  const digest = crypto.createHash("sha256").update(canonicalJson(body)).digest();
  const sig = soul.sign(digest);
  body.proof = {
    type: "DataIntegrityProof",
    cryptosuite: "eddsa-vapl-2024",
    created: nowIso(),
    verificationMethod: soul.verificationMethodId,
    proofPurpose: "assertionMethod",
    nonce: nonce(),
    proofValue: sig.toString("base64url"),
  };
  return body;
}

// ── Agent DID from wallet ─────────────────────────────────────────────────────
function agentDid(wallet) {
  if (wallet && wallet.length >= 10) {
    const h = crypto.createHash("sha256").update(wallet.toLowerCase()).digest();
    return `did:x402:${h.slice(0, 32).toString("base64url")}`;
  }
  return "did:x402:anonymous";
}

// ── Discovery manifest ────────────────────────────────────────────────────────
function buildManifest() {
  const soul = getSoul();
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2", "https://vapl.scriptmasterlabs.com/v1/context.jsonld"],
    id: `${soul.did}#soul`,
    type: "ProvenanceSoul",
    controller: soul.did,
    publicKeyMultibase: soul.publicKeyMultibase,
    service: "Crawltoll",
    endpoint: "https://crawltoll.onrender.com",
    capabilities: ["CrawltollFetch", "DataIngestion"],
    vcHeadersEmitted: true,
    vcHeader: "X-VAPL-VC",
    registry: "https://vapl-registry.onrender.com",
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getSoul, issueInteractionVc, agentDid, buildManifest };
