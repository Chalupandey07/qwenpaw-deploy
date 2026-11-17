// Vault router — the whole /vault surface.
//
// The model can USE a key but never SEE it. The value is decrypted ONLY
// inside this Worker; the model sends the key NAME + what it wants done;
// the Worker builds the request with the real key itself, and every byte
// coming back toward the model passes a redactor. See features/vault/README.md.
//
// Order of enforcement on every vault request, and the order matters:
//   1. session gate (requiresSession) — BEFORE any store access, so an
//      unauthenticated caller can never consume a read, a seal, or a use row.
//      The two exemptions are the static page (B-39 lesson) and the
//      broker-only /vault/export, which has its own shared-token auth.
//   2. rate limit, by endpoint class (reveal is the tightest — it is the
//      only route that ever returns a value).
//   3. validation (name, origin, header name, env var) — before any crypto.
//   4. only then the store, the seal/open, and the upstream fetch.
//
// The three leak paths this file is built against (DeepSeek design review,
// 2026-11-17):
//   (a) Tool echo: the outbound fetch is built entirely in here from the
//       sealed value; /vault/request returns only upstream status + body,
//       never the request it constructed.
//   (b) Destination not authenticated: the host is in the AAD (crypto.js)
//       AND enforced here before decrypting — decrypt only if the resolved
//       destination matches the sealed host. Errors to the model are uniform
//       ("upstream_error") regardless of cause, never length/prefix/format.
//   (c) Redaction misses a derived form: the form matrix (crypto.js) is
//       applied at the final boundary, AFTER all transforms, on the whole
//       buffered body — before truncation.

import {
  loadMasterKey, sealValue, openValue, redactionForms, redactText,
  hostForOrigin, VaultConfigError, CURRENT_KEY_VERSION,
} from "./crypto.js";
import { sessionFromRequest } from "../session.js";
import { authenticate } from "../machine-control.js";
import { enforce as rateLimit } from "../computer/rate-limit.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const KINDS = new Set(["bearer", "header", "basic", "command"]);
const HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Rakazo's header blocklist: the vault must never let a stored key override
// how the request itself is routed, authenticated, or framed.
const HEADER_BLOCKED_EXACT = new Set([
  "host", "connection", "content-length", "cookie", "origin", "referer",
  "authorization", "www-authenticate", "set-cookie", "transfer-encoding",
  "te", "trailer", "upgrade", "keep-alive", "proxy-authorization",
]);
const HEADER_BLOCKED_PREFIX = ["proxy-", "sec-"];
const HEADER_BLOCKED_SUBSTRING = ["forwarded"];
// Rakazo's reserved env-var list: a vault variable must never override how
// shells start, where code loads from, or how the network is reached.
const ENV_RESERVED_EXACT = new Set([
  "PATH", "HOME", "USER", "SHELL", "IFS", "TMPDIR", "DISPLAY",
  "SSH_AUTH_SOCK", "NODE_OPTIONS", "PYTHONPATH", "SSL_CERT_FILE",
  "NODE_TLS_REJECT_UNAUTHORIZED", "GIT_SSH", "GIT_ASKPASS",
  "BASH_ENV", "ENV", "CDPATH", "GITHUB_TOKEN", "CLOUDFLARE_API_TOKEN",
]);
const ENV_RESERVED_PREFIX = ["LD_", "DYLD_", "RAKAZO_", "GIT_CONFIG_", "NPM_CONFIG_"];
const ENV_RESERVED_SUFFIX = ["_PROXY"];

const MAX_VALUE_LENGTH = 8192;
const MAX_REQUEST_BODY = 256 * 1024;
const MAX_RESPONSE_BODY = 1024 * 1024;
const RESPONSE_TRUNCATE = 20000;
const FETCH_TIMEOUT_MS = 30000;
const REQUEST_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const ACTIVITY_LIMIT = 50;

/** The D1 database. VAULT_DB is preferred; COMPUTER_DB is the same database
 *  (qwenpaw-state) and is already bound on both Pages projects. */
function db(env) {
  return env.VAULT_DB || env.COMPUTER_DB;
}

function randomId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function nowMs() {
  return Date.now();
}

/** Constant-time string compare (timing-safe for token checks). */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function validName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

/** A bare https origin: no path, no query, no userinfo, no hash. */
function validOrigin(origin) {
  if (typeof origin !== "string" || !origin) return false;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && !u.username && !u.password
      && !u.hash && u.pathname === "/" && !u.search;
  } catch {
    return false;
  }
}

function validHeaderName(name) {
  if (typeof name !== "string" || !HEADER_TOKEN_RE.test(name)) return false;
  const lower = name.toLowerCase();
  if (HEADER_BLOCKED_EXACT.has(lower)) return false;
  if (HEADER_BLOCKED_PREFIX.some((p) => lower.startsWith(p))) return false;
  if (HEADER_BLOCKED_SUBSTRING.some((s) => lower.includes(s))) return false;
  return true;
}

/** Rakazo's commandVariableName: uppercase, `-` → `_`. */
function commandVarName(name) {
  return name.toUpperCase().replace(/-/g, "_");
}

/** Rakazo's commandVariableProblem: returns a reason string or null. */
function commandVarProblem(varName) {
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(varName)) return "invalid_var_name";
  if (ENV_RESERVED_EXACT.has(varName)) return "reserved_var_name";
  if (ENV_RESERVED_PREFIX.some((p) => varName.startsWith(p))) return "reserved_var_prefix";
  if (ENV_RESERVED_SUFFIX.some((s) => varName.endsWith(s))) return "reserved_var_suffix";
  return null;
}

async function recordUse(env, itemId, tool, site) {
  const d = db(env);
  if (!d) return;
  try {
    await d.prepare(
      `INSERT INTO vault_use (id, item_id, tool, site, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(randomId(), itemId, tool, site || "", nowMs()).run();
  } catch {
    // A use row that fails to write must not fail the request it records —
    // the audit trail is best-effort, the request is the point. The failure
    // is visible in the Worker's own logs, not in the response.
  }
}

async function loadItem(env, name) {
  const d = db(env);
  if (!d) return null;
  return d.prepare(`SELECT * FROM vault_item WHERE name = ?`).bind(name).first();
}

function publicItem(row) {
  return {
    name: row.name,
    kind: row.kind,
    origin: row.origin,
    title: row.title,
    note: row.note,
    policy: row.policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The gate. Written as an allowlist of EXEMPTIONS, not of gated paths: a new
 * endpoint added later is protected by default (the P0 lesson).
 *
 * Exempt:
 *   * the page itself (/vault, /vault/) — static bytes, B-39: the page is the
 *     way IN, and a gate on the door you must open to ask for a key is a
 *     lockout. Every endpoint it calls is still gated.
 *   * static assets under /vault (html/css/js/map/svg/png/ico/woff2) — bytes,
 *     not state. Matching on extension means a new endpoint (no extension)
 *     is gated by default.
 *   * POST /vault/export — the broker calls it from the machine, not a
 *     browser, so it has no session cookie. It is authenticated by
 *     VAULT_BROKER_TOKEN, constant-time, fail-closed when unset (the same
 *     pattern as the computer's machine-facing endpoints, which use
 *     COMPUTER_SYNC_TOKEN).
 */
export function requiresSession(path, method = "GET") {
  if (method === "OPTIONS") return false;
  if (path === "/vault" || path === "/vault/") return false;
  if (/^\/vault\/[A-Za-z0-9_.-]+\.(html|css|js|map|svg|png|ico|woff2?)$/.test(path)) return false;
  if (path === "/vault/export" && method === "POST") return false;
  return true;
}

function limitClass(path, method) {
  if (path === "/vault/reveal") return "vault_reveal";
  if (path === "/vault/request") return "vault_request";
  if (path === "/vault/export") return "vault_export";
  if (path === "/vault/put" || path === "/vault/remove") return "vault_mutation";
  if (path === "/vault/list" || path === "/vault/activity") return "vault_read";
  return null;
}

export async function handleVault(request, env, url, origin) {
  const path = url.pathname;
  const q = url.searchParams;

  // ---- authentication gate (P0 pattern, 2026-11-16) ----
  if (requiresSession(path, request.method)) {
    const session = await sessionFromRequest(env, request);
    if (!session.ok) {
      if (session.reason === "unconfigured") {
        return json({
          error: "session_unconfigured",
          reason: "unconfigured",
          detail: "COMPUTER_SESSION_SECRET (or COMPUTER_CAPABILITY_SECRET) is not set on "
            + "this Pages project, so no session can be verified.",
        }, 503);
      }
      return json({
        error: "auth_required",
        reason: session.reason,
        detail: "Open the QwenPaw console and sign in, then reload this page.",
      }, 401);
    }
  }

  // ---- rate limit ----
  const cls = limitClass(path, request.method);
  if (cls) {
    const limited = await rateLimit(request, env, cls);
    if (limited) return limited;
  }

  // ---- UI ----
  if (path === "/vault" || path === "/vault/") return serveUi(env, url);
  if (path === "/vault/vault.js") {
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
      if (res && res.ok) {
        return new Response(res.body, {
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }

  const d = db(env);
  if (!d) {
    return json({ error: "vault_unconfigured", detail: "No D1 binding is available." }, 503);
  }

  // ---- helpers that need the master key ----
  // loadMasterKey throws VaultConfigError; the handler maps it to a generic
  // 503 and never echoes details (the code, not the secret, is logged).
  const withKey = async (fn) => {
    try {
      const key = await loadMasterKey(env);
      return await fn(key);
    } catch (e) {
      if (e instanceof VaultConfigError) {
        return json({ error: "vault_unavailable" }, 503);
      }
      throw e;
    }
  };

  // ---- list ----
  if (path === "/vault/list" && request.method === "GET") {
    const rows = await d.prepare(
      `SELECT name, kind, origin, title, note, policy, created_at, updated_at
       FROM vault_item ORDER BY name ASC`,
    ).all();
    // Metadata only. NEVER ciphertext, never a value, never a row id.
    return json({ items: (rows.results || []).map(publicItem) });
  }

  // ---- put ----
  if (path === "/vault/put" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400);
    }
    const { name, kind, origin, headerName, username, value, title, note } = body || {};
    if (!validName(name)) return json({ error: "bad_name", detail: "name must match ^[a-z][a-z0-9_-]{0,63}$" }, 400);
    if (!KINDS.has(kind)) return json({ error: "bad_kind", detail: "kind must be bearer | header | basic | command" }, 400);
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_VALUE_LENGTH) {
      return json({ error: "bad_value", detail: "value must be a non-empty string up to 8192 chars" }, 400);
    }
    let o = "";
    if (kind === "command") {
      if (origin) return json({ error: "bad_origin", detail: "command items have no origin" }, 400);
      const varName = commandVarName(name);
      const problem = commandVarProblem(varName);
      if (problem) return json({ error: "reserved_var", detail: problem }, 409);
      // A second item mapping to the same VAR is a conflict, even under a
      // different name: the broker exports one VAR per command.
      const clash = await d.prepare(
        `SELECT name FROM vault_item WHERE kind = 'command' AND UPPER(REPLACE(name, '-', '_')) = ? AND name != ?`,
      ).bind(varName, name).first();
      if (clash) return json({ error: "var_conflict", detail: `env var ${varName} is already used by ${clash.name}` }, 409);
    } else {
      if (!validOrigin(origin)) {
        return json({ error: "bad_origin", detail: "origin must be a bare https:// origin (no path, query, userinfo, or hash)" }, 400);
      }
      o = origin;
    }
    if (kind === "header" && !validHeaderName(headerName)) {
      return json({ error: "bad_header_name", detail: "header name is blocked or not a valid token" }, 400);
    }
    if (kind === "basic" && (typeof username !== "string" || !username)) {
      return json({ error: "bad_username", detail: "basic items need a username" }, 400);
    }
    return withKey(async (key) => {
      const existing = await loadItem(env, name);
      const id = existing ? existing.id : randomId();
      const keyVersion = existing ? existing.key_version : CURRENT_KEY_VERSION;
      const host = hostForOrigin(o);
      const ciphertext = await sealValue(key, { itemId: id, kind, host, keyVersion }, value);
      const now = nowMs();
      if (existing) {
        await d.prepare(
          `UPDATE vault_item SET kind = ?, origin = ?, header_name = ?, username = ?,
           ciphertext = ?, key_version = ?, title = ?, note = ?, updated_at = ? WHERE id = ?`,
        ).bind(kind, o, kind === "header" ? headerName : null, kind === "basic" ? username : null,
          ciphertext, keyVersion, title || "", note || "", now, id).run();
      } else {
        await d.prepare(
          `INSERT INTO vault_item (id, name, kind, origin, header_name, username, ciphertext,
           key_version, title, note, policy, scope, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'allow', 'agent', ?, ?)`,
        ).bind(id, name, kind, o, kind === "header" ? headerName : null,
          kind === "basic" ? username : null, ciphertext, keyVersion,
          title || "", note || "", now, now).run();
      }
      const row = await loadItem(env, name);
      return json({ ok: true, item: publicItem(row) });
    });
  }

  // ---- reveal ----
  // Owner only: the session cookie proves a console login, AND the caller
  // must ALSO present the console bearer token (verified against
  // /api/cron/jobs, the endpoint that actually protects a session — the
  // /api/auth/status lesson, B-37). A machine token is NOT enough: the
  // broker must never be able to reveal a value.
  if (path === "/vault/reveal" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400);
    }
    if (!validName(body && body.name)) return json({ error: "bad_name" }, 400);
    const auth = await authenticate(request, env, origin);
    if (!auth.ok || auth.via !== "console_session") {
      return json({ error: "auth_required", detail: "Reveal needs the console session token." }, 401);
    }
    const row = await loadItem(env, body.name);
    if (!row) return json({ error: "not_found" }, 404);
    return withKey(async (key) => {
      const value = await openValue(key, {
        itemId: row.id, kind: row.kind, host: hostForOrigin(row.origin),
        keyVersion: row.key_version,
      }, row.ciphertext);
      if (value === null) return json({ error: "vault_corrupt", detail: "The stored value cannot be opened." }, 500);
      await recordUse(env, row.id, "reveal", "");
      // The value is returned ONCE, in this response only. It is never
      // stored in page state (the UI shows it in a transient dialog).
      return json({ value });
    });
  }

  // ---- remove ----
  if (path === "/vault/remove" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400);
    }
    if (!validName(body && body.name)) return json({ error: "bad_name" }, 400);
    const row = await loadItem(env, body.name);
    if (!row) return json({ error: "not_found" }, 404);
    await d.batch([
      d.prepare(`DELETE FROM vault_use WHERE item_id = ?`).bind(row.id),
      d.prepare(`DELETE FROM vault_item WHERE id = ?`).bind(row.id),
    ]);
    return json({ ok: true });
  }

  // ---- activity ----
  if (path === "/vault/activity" && request.method === "GET") {
    const name = q.get("name") || "";
    if (!validName(name)) return json({ error: "bad_name" }, 400);
    const row = await loadItem(env, name);
    if (!row) return json({ error: "not_found" }, 404);
    const rows = await d.prepare(
      `SELECT tool, site, created_at FROM vault_use WHERE item_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).bind(row.id, ACTIVITY_LIMIT).all();
    return json({
      item: publicItem(row),
      uses: (rows.results || []).map((u) => ({ tool: u.tool, site: u.site, createdAt: u.created_at })),
    });
  }

  // ---- request (the injection endpoint) ----
  if (path === "/vault/request" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400);
    }
    const { name, url, method, body: reqBody, contentType } = body || {};
    if (!validName(name)) return json({ error: "bad_name" }, 400);
    if (typeof url !== "string" || !url) return json({ error: "bad_url" }, 400);
    const m = (method || "GET").toUpperCase();
    if (!REQUEST_METHODS.has(m)) return json({ error: "bad_method" }, 400);
    if (reqBody !== undefined && reqBody !== null) {
      if (typeof reqBody !== "string" || reqBody.length > MAX_REQUEST_BODY) {
        return json({ error: "bad_body", detail: "request body must be a string up to 256 KB" }, 400);
      }
    }
    if (contentType !== undefined && contentType !== null) {
      if (typeof contentType !== "string" || /[\r\n]/.test(contentType) || contentType.length > 200) {
        return json({ error: "bad_content_type" }, 400);
      }
    }
    const row = await loadItem(env, name);
    if (!row) return json({ error: "not_found" }, 404);
    if (row.policy !== "allow") return json({ error: "vault_policy_off", detail: "This item is disabled." }, 403);
    if (row.kind === "command") {
      return json({ error: "vault_command_not_requestable", detail: "Command items are env-only; use vault_run." }, 400);
    }
    // Origin pin, enforced BEFORE decrypting: the destination must match the
    // sealed host. Decrypt only if it does (leak (b) mitigation).
    let target;
    try {
      target = new URL(url);
    } catch {
      return json({ error: "bad_url" }, 400);
    }
    if (target.protocol !== "https:" || target.username || target.password || target.hash) {
      return json({ error: "bad_url", detail: "URL must be https with no userinfo or hash" }, 400);
    }
    if (target.origin !== row.origin) {
      // Refused AND no vault_use row: the request never went out.
      return json({ error: "vault_origin_mismatch", detail: "URL origin does not match the item's pinned origin" }, 403);
    }
    return withKey(async (key) => {
      const value = await openValue(key, {
        itemId: row.id, kind: row.kind, host: hostForOrigin(row.origin),
        keyVersion: row.key_version,
      }, row.ciphertext);
      if (value === null) return json({ error: "vault_corrupt", detail: "The stored value cannot be opened." }, 500);
      const forms = redactionForms(row.kind, { value, headerName: row.header_name, username: row.username });
      // Build the auth header server-side. The value never leaves this
      // Worker except inside the Authorization header of the upstream call.
      const headers = new Headers();
      if (row.kind === "bearer") headers.set("Authorization", `Bearer ${value}`);
      else if (row.kind === "basic") headers.set("Authorization", `Basic ${value}`);
      else if (row.kind === "header") headers.set(row.header_name, value);
      if (contentType) headers.set("Content-Type", contentType);
      headers.set("Accept", "application/json, */*;q=0.8");
      // The request body is capped by the fetch itself (a string body of at
      // most 256 KB, validated above). GET/HEAD carry no body.
      const init = {
        method: m, headers, redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      };
      if (reqBody !== undefined && reqBody !== null && m !== "GET" && m !== "HEAD") init.body = reqBody;
      let res;
      try {
        res = await fetch(url, init);
      } catch {
        // The request may have gone out before it failed (timeout, reset).
        // Record the use, then answer with the uniform error shape.
        await recordUse(env, row.id, "request", row.origin);
        return json({ error: "upstream_error" }, 502);
      }
      await recordUse(env, row.id, "request", row.origin);
      // Read the body with a 1 MB cap, without buffering past it. The
      // reader stops as soon as the cap is crossed.
      let text = "";
      let truncated = false;
      try {
        const reader = res.body ? res.body.getReader() : null;
        if (reader) {
          let received = 0;
          for (;;) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            received += chunk.byteLength;
            if (received > MAX_RESPONSE_BODY) {
              truncated = true;
              try { await reader.cancel(); } catch { /* already closed */ }
              break;
            }
            text += new TextDecoder().decode(chunk, { stream: true });
          }
          text += new TextDecoder().decode();
        } else {
          text = await res.text();
          if (text.length > MAX_RESPONSE_BODY) truncated = true;
        }
      } catch {
        return json({ error: "upstream_error" }, 502);
      }
      if (text.length > MAX_RESPONSE_BODY) {
        text = text.slice(0, MAX_RESPONSE_BODY);
        truncated = true;
      }
      // Redact BEFORE truncation to 20,000 chars: a value split across the
      // truncation boundary must still be hidden.
      const redacted = redactText(text, forms);
      const outBody = redacted.length > RESPONSE_TRUNCATE
        ? redacted.slice(0, RESPONSE_TRUNCATE) : redacted;
      if (redacted.length > RESPONSE_TRUNCATE) truncated = true;
      // Response headers: only content-type and link, both redacted. A Link
      // header carrying the credential is dropped whole (checked raw + 3
      // rounds of percent-decoding, per the Rakazo study).
      const outHeaders = {};
      const ct = res.headers.get("content-type");
      if (ct) outHeaders["content-type"] = redactText(ct, forms);
      const link = res.headers.get("link");
      if (link && !carriesCredential(link, forms)) {
        outHeaders.link = redactText(link, forms);
      }
      return json({ status: res.status, headers: outHeaders, body: outBody, truncated });
    });
  }

  // ---- export (broker-only) ----
  // The broker authenticates with VAULT_BROKER_TOKEN, constant-time,
  // fail-closed when unset. This is the ONLY route that dispenses values,
  // and only over the mutually-authenticated broker channel.
  if (path === "/vault/export" && request.method === "POST") {
    const brokerToken = env.VAULT_BROKER_TOKEN;
    if (!brokerToken) {
      return json({ error: "vault_broker_unconfigured", detail: "VAULT_BROKER_TOKEN is not set." }, 503);
    }
    const supplied = request.headers.get("X-Vault-Broker-Token") || "";
    if (!supplied || !safeEqual(supplied, brokerToken)) {
      return json({ error: "auth_required", detail: "Invalid broker token." }, 401);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400);
    }
    const names = body && body.names;
    if (!Array.isArray(names) || names.length === 0 || names.length > 20) {
      return json({ error: "bad_names", detail: "names must be an array of 1-20 item names" }, 400);
    }
    for (const n of names) if (!validName(n)) return json({ error: "bad_name" }, 400);
    return withKey(async (key) => {
      const items = [];
      for (const n of names) {
        const row = await loadItem(env, n);
        if (!row) return json({ error: "not_found", detail: `No vault item named ${n}` }, 404);
        if (row.policy !== "allow") return json({ error: "vault_policy_off", detail: `${n} is disabled.` }, 403);
        const value = await openValue(key, {
          itemId: row.id, kind: row.kind, host: hostForOrigin(row.origin),
          keyVersion: row.key_version,
        }, row.ciphertext);
        if (value === null) return json({ error: "vault_corrupt", detail: `The stored value for ${n} cannot be opened.` }, 500);
        await recordUse(env, row.id, "export", "broker");
        items.push({
          name: row.name,
          kind: row.kind,
          // The env var the broker exports (command items) or the header
          // name the broker would use — the broker decides by kind.
          varName: commandVarName(row.name),
          // Metadata the broker needs to enforce the same rules the Worker
          // enforces: the origin pin (checked against the requested URL
          // before the broker builds its own request) and the header name
          // (for header-kind items). Metadata, not a value — safe on the
          // authenticated broker channel.
          origin: row.origin,
          headerName: row.header_name,
          value,
        });
      }
      return json({ items });
    });
  }

  return json({ error: "not_found" }, 404);
}

/** Does a header/link value carry the credential (raw, or after up to 3
 *  rounds of percent-decoding)? If so it is dropped whole, not redacted. */
function carriesCredential(text, forms) {
  let cur = text;
  for (let round = 0; round <= 3; round += 1) {
    for (const f of forms) if (f && cur.includes(f)) return true;
    try {
      const next = decodeURIComponent(cur);
      if (next === cur) break;
      cur = next;
    } catch {
      break;
    }
  }
  return false;
}

async function serveUi(env, url) {
  if (!env.ASSETS) return new Response("not found", { status: 404 });
  const res = await env.ASSETS.fetch(new Request(new URL("/vault/ui.html", url.origin)));
  if (!res || !res.ok) return new Response("not found", { status: 404 });
  return new Response(res.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
