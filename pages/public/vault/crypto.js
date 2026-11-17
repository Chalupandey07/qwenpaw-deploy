// Vault crypto — WebCrypto AES-256-GCM seal/open + redaction forms.
//
// DESIGN (DeepSeek design review, 2026-11-17, full text in
// /tmp/vault-crypto-design.txt — ephemeral, the decisions are recorded here):
//
//   1. Master key: VAULT_MASTER_SECRET is 32 random bytes (256-bit entropy),
//      hex-encoded. Import the 32 raw bytes DIRECTLY as the AES-256-GCM key.
//      No SHA-256, no HKDF — a KDF adds nothing against brute force and
//      cannot "improve" uniform randomness. Worse, SHA-256(secretString) is
//      encoding-dependent: hashing the 64-char hex string and hashing the 32
//      decoded bytes produce different keys, and any environment where one
//      path has quotes/0x/whitespace and another doesn't silently produces a
//      second key. Decode-then-import makes the byte→key mapping explicit.
//   2. AAD: `vault\0v1\0<itemId>\0<kind>\0<host>\0value\0<key_version>`.
//      `name` is deliberately NOT in the AAD — it is mutable display
//      metadata, and binding it forces a re-seal on every rename for zero
//      security gain (name authorises nothing). `kind` stops cross-type
//      confusion (a sealed `basic` blob re-labelled `header`). `host` is the
//      important one: if the destination is editable metadata and not in
//      the AAD, an attacker who can write the row points the key at their
//      own server and the Worker exfiltrates it on next use. `key_version`
//      allows rotation with dual-read.
//   3. Redaction: per-kind form sets (raw, JSON-escaped, percent-encoded,
//      scheme-prefixed, basic decoded forms), minimum form length 8 (6-char
//      forms cause collateral redaction of ordinary substrings). Overlapping
//      matches are merged by collecting ALL ranges manually — never one
//      alternation regex, which returns non-overlapping matches and silently
//      drops overlapping longer forms.
//   4. The Worker buffers the upstream response (`await res.text()`) and
//      redacts the whole body — simpler and strictly safer than streaming
//      redaction. The streaming variant exists for the broker, which may
//      relay a live child process's output.
//
// What the AAD does NOT stop (recorded, not hidden): replay of an older
// valid ciphertext for the SAME item/kind/host (rollback); someone who can
// write D1 can delete rows or swap entire rows consistently. Assume DB
// write access is game over unless rows are also signed.

const te = new TextEncoder();

const HEX64 = /^[0-9a-f]{64}$/i;
const PLACEHOLDERS = new Set([
  "0".repeat(64), "f".repeat(64),
  "change-me", "changeme", "replace-me", "your-secret-here",
]);
// AAD fields must not contain \0 (it is the separator) or characters that
// let one field shift into another. Hostnames, kinds, ids, and versions all
// fit this charset.
const AAD_FIELD = /^[A-Za-z0-9._:@-]{1,128}$/;

export const REDACTED = "[redacted]";
export const MIN_FORM_LENGTH = 8;
export const CURRENT_KEY_VERSION = "1";

function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text) {
  const pad = text.length % 4 ? "=".repeat(4 - (text.length % 4)) : "";
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

export class VaultConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "VaultConfigError";
    this.code = code;
  }
}

// Per-isolate cache, keyed on the raw secret string, so a rotated secret
// invalidates automatically.
let keyCache = { raw: null, key: null };

/**
 * Load the vault master key from env.VAULT_MASTER_SECRET.
 *
 * One encoding only (hex), syntactically permissive about transport
 * artifacts (quotes, 0x, trailing newline). Throws VaultConfigError on
 * anything wrong — never returns null, never falls back to a default or
 * to storing plaintext. The route handler maps it to 503 vault_unavailable.
 */
export async function loadMasterKey(env) {
  let raw = String(env?.VAULT_MASTER_SECRET ?? "").trim();
  if ((raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1).trim();
  if (raw.startsWith("0x") || raw.startsWith("0X")) raw = raw.slice(2);

  if (!raw) throw new VaultConfigError("vault_master_unset");
  if (!HEX64.test(raw)) throw new VaultConfigError("vault_master_bad_format");

  const lower = raw.toLowerCase();
  if (PLACEHOLDERS.has(lower) || /^(.)\1{63}$/.test(lower)) {
    throw new VaultConfigError("vault_master_placeholder");
  }
  if (keyCache.raw === lower) return keyCache.key;

  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(lower.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey(
    "raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"],
  );
  bytes.fill(0);
  keyCache = { raw: lower, key };
  return key;
}

/**
 * The AAD for one sealed value. `host` is the destination hostname the key
 * may be sent to (lowercased), or the literal "command" for env-only items.
 * Every field is charset-checked so no field can contain the \0 separator.
 */
export function aadBytes({ itemId, kind, host, keyVersion = CURRENT_KEY_VERSION }) {
  const h = host === "" ? "command" : String(host).toLowerCase();
  for (const f of [itemId, kind, h, "value", keyVersion]) {
    if (!AAD_FIELD.test(f)) throw new Error("invalid_aad_field");
  }
  return te.encode(`vault\0v1\0${itemId}\0${kind}\0${h}\0value\0${keyVersion}`);
}

/** The hostname an origin pins, lowercased. '' for command items. */
export function hostForOrigin(origin) {
  if (!origin) return "";
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Seal a plaintext value. Returns `v1:<base64url(iv|ciphertext|tag)>`.
 * WebCrypto's AES-GCM ENCRYPT returns ciphertext||tag as one buffer, so the
 * whole tail is stored — unlike node:crypto, which takes the tag separately.
 */
export async function sealValue(key, { itemId, kind, host, keyVersion }, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = aadBytes({ itemId, kind, host, keyVersion });
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad }, key, te.encode(plaintext),
  );
  return `v1:${b64url(new Uint8Array([...iv, ...new Uint8Array(ct)]))}`;
}

/**
 * Open a sealed value. Returns the plaintext string, or null for genuine
 * AEAD failure (tamper / wrong AAD / wrong key). A VaultConfigError is NOT
 * swallowed into null — a misconfigured deployment is loud, not silently
 * "wrong key". Callers must pass the row's own id/kind/host/keyVersion,
 * never a request field, into the AAD.
 */
export async function openValue(key, { itemId, kind, host, keyVersion }, ciphertext) {
  if (typeof ciphertext !== "string" || !ciphertext.startsWith("v1:")) return null;
  try {
    const raw = unb64url(ciphertext.slice(3));
    if (raw.length < 12 + 16) return null;
    const iv = raw.subarray(0, 12);
    const ct = raw.subarray(12);
    const aad = aadBytes({ itemId, kind, host, keyVersion });
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad }, key, ct,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/**
 * Redaction forms for one value, by kind. Ranked by reachability; the
 * forms that are over-engineering are NOT generated:
 *   - base64 of a whole header (only through log pipelines that base64
 *     headers — not our path);
 *   - base64 of a header value (not reachable in a response).
 * Schemes are case-insensitive, so the prefix gets case variants; the
 * secret itself is matched case-sensitively (case-folding it would be
 * collateral damage). Multi-line values contribute the full value AND each
 * long unspaced line, because pretty-printers and terminal wrappers reflow
 * them.
 */
export function redactionForms(kind, { value, headerName, username }) {
  const v = String(value ?? "");
  const out = new Set();
  const add = (x) => {
    if (typeof x === "string" && x.length >= MIN_FORM_LENGTH) out.add(x);
  };

  add(v);
  add(JSON.stringify(v).slice(1, -1)); // JSON-escaped
  add(encodeURIComponent(v));

  if (kind === "bearer") {
    add(`Bearer ${v}`);
    add(`bearer ${v}`);
    add(`BEARER ${v}`);
  } else if (kind === "basic") {
    // `value` is the base64 of user:password (the stored form). The decoded
    // forms matter because any tool that decodes Basic or prints a URL with
    // userinfo exposes them.
    const b64 = v.replace(/^Basic\s+/i, "");
    add(b64);
    add(`Basic ${b64}`);
    add(`basic ${b64}`);
    add(encodeURIComponent(b64));
    try {
      const decoded = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
      add(decoded); // user:pass
      add(encodeURIComponent(decoded)); // user%3Apass
      const c = decoded.indexOf(":");
      if (c !== -1) add(decoded.slice(c + 1)); // password alone
      if (username) add(`${username}:${decoded.slice(c + 1)}`);
    } catch {
      // Not valid base64 — the raw forms above still apply.
    }
  } else if (kind === "header") {
    // Raw + JSON-escaped + percent-encoded are already added above.
    // The full header line is reachable when headers are dumped.
    if (headerName) add(`${headerName}: ${v}`);
  }

  if (v.includes("\n")) {
    for (const line of v.split("\n")) add(line.trim());
  }
  return [...out];
}

/**
 * Merge overlapping (or touching) ranges, then rebuild the string once.
 * Collect ALL ranges manually — one alternation regex returns
 * non-overlapping matches leftmost-first and silently drops overlapping
 * longer forms. Touching ranges merge too, which avoids
 * `[redacted][redacted]` when a token and its header form abut.
 */
function mergeRanges(text, forms) {
  const r = [];
  for (const f of forms) {
    let i = 0;
    while ((i = text.indexOf(f, i)) !== -1) {
      r.push([i, i + f.length]);
      i += 1;
    }
  }
  r.sort((a, b) => a[0] - b[0] || b[1] - a[1]); // start asc, longer first
  const merged = [];
  for (const [s, e] of r) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/** Redact every form in `text`, replacing each with `[redacted]`. */
export function redactText(text, forms) {
  if (typeof text !== "string" || !text || !forms || forms.length === 0) return text;
  const m = mergeRanges(text, forms);
  if (!m.length) return text;
  let out = "";
  let p = 0;
  for (const [s, e] of m) {
    out += text.slice(p, s) + REDACTED;
    p = e;
  }
  return out + text.slice(p);
}

/**
 * Streaming redactor. Needed only where text reaches the model WITHOUT
 * full buffering (SSE relays, streaming tool stdout, tail -f). The Worker
 * buffers the upstream response and uses redactText() — simpler and
 * strictly safer. The broker uses this for a live child process's output.
 *
 * Correctness invariant: any match is at most maxLen chars, so holding
 * back maxLen - 1 chars means every match that STARTS in the emitted
 * region is fully present in the buffer. Memory is bounded by the longest
 * form — except a multi-KB PEM, which effectively buffers; cap the forms
 * fed here and prefer buffering for large multi-line secrets.
 */
export function makeStreamRedactor(forms) {
  const maxLen = Math.max(1, ...forms.map((f) => f.length));
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      const cut = buf.length - (maxLen - 1); // first position safe to emit
      if (cut <= 0) return "";
      const m = mergeRanges(buf, forms);
      let emit = cut;
      for (const [s, e] of m) if (s < cut && e > emit) emit = e;
      let out = "";
      let p = 0;
      for (const [s, e] of m) {
        if (e <= emit) {
          out += buf.slice(p, s) + REDACTED;
          p = e;
        } else break;
      }
      out += buf.slice(p, emit);
      buf = buf.slice(emit);
      return out;
    },
    flush() {
      const out = redactText(buf, forms);
      buf = "";
      return out;
    },
  };
}
