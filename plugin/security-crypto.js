"use strict";

// js-sha256 0.11.1 (MIT) est embarque localement : UXP documente
// crypto.getRandomValues(), mais ne garantit pas SubtleCrypto.
const sha256 = require("./vendor/js-sha256");

function resolveCryptoApi(scope) {
  if (scope && scope.crypto) return scope.crypto;
  if (typeof window === "object" && window && window.crypto) return window.crypto;
  if (typeof globalThis === "object" && globalThis && globalThis.crypto) return globalThis.crypto;
  if (typeof crypto !== "undefined") return crypto;
  return null;
}

function utf8Encode(input) {
  const output = [];
  for (let i = 0; i < input.length; i += 1) {
    let codePoint = input.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (codePoint <= 0x7f) output.push(codePoint);
    else if (codePoint <= 0x7ff) output.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint <= 0xffff) output.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    else output.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  }
  return new Uint8Array(output);
}

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((entry) => entry.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return null;
  const output = new Uint8Array(value.length / 2);
  for (let i = 0; i < output.length; i += 1) output[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return output;
}

function localHmacSha256Hex(key, message) {
  return sha256.hmac(key, message);
}

function supportsSubtleHmac(cryptoApi) {
  const subtle = cryptoApi && cryptoApi.subtle;
  return Boolean(
    subtle
    && typeof subtle.importKey === "function"
    && typeof subtle.sign === "function"
    && typeof subtle.verify === "function"
  );
}

async function importHmacKey(secret, cryptoApi) {
  const keyBytes = utf8Encode(secret);
  if (supportsSubtleHmac(cryptoApi)) {
    try {
      const key = await cryptoApi.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: { name: "SHA-256" } },
        false,
        ["sign", "verify"]
      );
      return { mode: "subtle", key, subtle: cryptoApi.subtle };
    } catch (_) {
      // Même algorithme et même clé via l'implémentation locale auditée.
    }
  }
  return { mode: "local", keyBytes };
}

async function signHmacHex(hmacKey, message) {
  if (!hmacKey) throw new Error("HMAC_KEY_REQUIRED");
  const messageBytes = utf8Encode(message);
  if (hmacKey.mode === "subtle") {
    return bytesToHex(await hmacKey.subtle.sign("HMAC", hmacKey.key, messageBytes));
  }
  return localHmacSha256Hex(hmacKey.keyBytes, messageBytes);
}

function safeEqualBytes(left, right) {
  const candidate = right || new Uint8Array(left.length);
  let difference = left.length ^ candidate.length;
  for (let i = 0; i < left.length; i += 1) {
    difference |= left[i] ^ (i < candidate.length ? candidate[i] : 0);
  }
  return difference === 0;
}

function stableStringify(value) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Nombre non fini interdit");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }
  throw new Error("Type JSON interdit");
}

function canonicalCommand(message, sessionChallenge) {
  return "command:" + sessionChallenge + ":" + stableStringify({
    id: message.id,
    command: message.command,
    documentId: message.documentId === undefined ? null : message.documentId,
    expectedRevision: message.expectedRevision === undefined ? null : message.expectedRevision,
    expectedStateToken: message.expectedStateToken === undefined ? null : message.expectedStateToken,
    nonce: message.nonce,
    args: message.args || {}
  });
}

async function verifyHmacHex(hmacKey, message, proof) {
  if (!hmacKey) return false;
  const signature = hexToBytes(proof);
  if (hmacKey.mode === "subtle") {
    if (!signature) return false;
    return hmacKey.subtle.verify("HMAC", hmacKey.key, signature, utf8Encode(message));
  }
  const expected = hexToBytes(await signHmacHex(hmacKey, message));
  return safeEqualBytes(expected, signature);
}

module.exports = {
  bytesToHex,
  canonicalCommand,
  importHmacKey,
  localHmacSha256Hex,
  resolveCryptoApi,
  signHmacHex,
  stableStringify,
  utf8Encode,
  verifyHmacHex
};
