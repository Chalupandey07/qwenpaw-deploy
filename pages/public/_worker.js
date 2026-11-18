// QwenPaw reverse proxy — Cloudflare Pages Advanced Mode (_worker.js).
// Root / and everything else is proxied to the QwenPaw console on InstaBox.
// /status (and /status.html) serves the status / wake page from static assets.
// Every proxied visit hits the InstaBox public URL, which counts as activity
// and wakes an auto-paused box; the 5-minute Worker cron is the other keeper.
//
// COMPUTER REMOVED 2026-11-15. This Worker used to carry the whole /desktop
// surface (gate page, noVNC proxy, lease, capabilities, previews, needs-you,
// teach, modes). It was removed deliberately so the computer could be rebuilt
// from Rakazo's design rather than patched further; see features/computer/.
// What remains is exactly the console proxy plus the wake/cooldown handling,
// and that is the entire responsibility of this file.
import { handleComputer } from "./computer/router.js";
import { handleVault } from "./vault/router.js";
import { handleReset } from "./reset/router.js";
import { restMachine, sleepMachine, machineState, authenticate } from "./machine-control.js";
import {
  mintSession, sessionFromRequest, sessionSetCookie, sessionClearCookie, SESSION_TTL_MS,
} from "./session.js";

const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const WAKE_WAIT_MS = 45_000;
const KEEPALIVE_URL = "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev";
const MACHINE_ID = "m_" + new URL(ORIGIN).hostname.split(".")[0].split("-").slice(1).join("-");

// AgentX rebrand (2026-11-18, features/rebrand/README.md). The product is
// AgentX now; the upstream console still calls itself QwenPaw, so the
// visible rename is done by DOM injection (headShim + the rebrand rules
// inside computerPanelScript) — never by rewriting the bundle. These are
// the single source of truth for the pinned upstream version and the
// upstream hosts the shim swallows. The image is pinned by digest in the
// machine's docker-compose.yml (agentscope/qwenpaw:v2.3.0@sha256:46a782…),
// so the version the PyPI stub returns can never drift from what runs.
const PINNED_QWENPAW_VERSION = "2.3.0";
const PYPI_QWENPAW_URL = "https://pypi.org/pypi/qwenpaw/json";
const UPSTREAM_DOC_ORIGIN = "https://qwenpaw.agentscope.io";
const UPSTREAM_GITHUB_URL = "https://github.com/agentscope-ai/QwenPaw";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rewrite response headers for the Pages origin.
 *
 * This function was written on 2026-11-15 to close audit finding
 * `proxy-open-redirect-rewrite-gap` (A-6) and to carry the Referrer-Policy
 * half of the `qwenpaw-query-token-leak` fix. The 8,399-line computer
 * removal deleted it as collateral while leaving its call site in `proxy()`,
 * which made this Worker throw a ReferenceError on *every* proxied request —
 * the whole console, not just the computer. Restored here verbatim; the
 * reasoning below is the original.
 */
function rewriteHeaders(res, pagesOrigin) {
  const headers = new Headers(res.headers);
  // Rewrite redirects that point at the origin so the browser stays on Pages.
  // Hardened: the old code only rewrote absolute ORIGIN URLs. A
  // protocol-relative Location (//evil.example/x) or a foreign absolute URL
  // (https://evil.example/x) passed through unrewritten, so our Pages
  // domain could redirect visitors elsewhere. QwenPaw emits no Location
  // headers at all today (verified in source), so any Location is
  // hypothetical — but a foreign redirect must never leave here intact.
  const loc = headers.get("Location");
  if (loc) {
    if (loc.startsWith(ORIGIN)) {
      headers.set("Location", pagesOrigin + loc.slice(ORIGIN.length));
    } else if (loc.startsWith("//")) {
      try {
        const u = new URL("https:" + loc);
        if (u.origin === ORIGIN) {
          headers.set("Location", pagesOrigin + u.pathname + u.search + u.hash);
        } else {
          headers.delete("Location");
        }
      } catch {
        headers.delete("Location");
      }
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(loc)) {
      headers.delete("Location"); // absolute URL to a foreign host
    }
    // A relative Location ("/path") passes through — it stays on Pages.
  }
  // Framing guard on proxied HTML: the console must not be embeddable in
  // another site's iframe (clickjacking). SAMEORIGIN is safe here — nothing
  // in our setup embeds the console cross-origin.
  //
  // Referrer-Policy is part of the qwenpaw-query-token-leak fix: a user can
  // land on a `?token=...` URL (old bookmark, pasted link) and any outbound
  // link click would otherwise send it in the Referer header to a third
  // party. `same-origin` keeps same-origin navigation working and sends
  // nothing cross-origin.
  headers.set("Referrer-Policy", "same-origin");
  const contentType = headers.get("Content-Type") || "";
  if (contentType.includes("text/html")) {
    headers.set("X-Frame-Options", "SAMEORIGIN");
    headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  }
  // If the origin ever sets a Domain on a cookie, strip it so the cookie
  // becomes host-only for the Pages domain instead of the InstaBox host.
  const setCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (headers.get("Set-Cookie") ? [headers.get("Set-Cookie")] : []);
  if (setCookies.length) {
    headers.delete("Set-Cookie");
    for (const c of setCookies) {
      headers.append("Set-Cookie", c.replace(/;\s*domain=[^;]+/gi, ""));
    }
  }
  return headers;
}

/**
 * The AgentX early shim (rebrand, 2026-11-18).
 *
 * A classic inline <script> injected before </body> (see proxy()). The
 * console bundle is a deferred <script type="module">, so this classic
 * script runs FIRST — that is what makes the two patches win the race:
 *
 *   (a) window.fetch: the console polls https://pypi.org/pypi/qwenpaw/json
 *       hourly and shows "Update Available" / "Update QwenPaw?" when the
 *       version differs. Only that ONE exact URL is answered, with the
 *       pinned version (2.3.0, the digest-pinned image that actually runs),
 *       so the checker always sees "up to date" and never nags. Every
 *       other fetch falls through to the native fetch untouched.
 *   (b) window.open: swallows the two upstream hosts (the docs site and
 *       the upstream GitHub repo) by returning null without opening. Every
 *       other URL falls through to the native window.open untouched.
 *
 * Both patches are wrapped in try/catch and fall through to native on any
 * unmatched or unexpected input — a patch bug must never break a real
 * request. Kill switch: ?rebrand=0 in the page URL skips the whole shim,
 * and the worker env var AGENTX_REBRAND=0 skips emitting it (see proxy()).
 */
function headShim() {
  return `<script>
(function () {
  try {
    var off = false;
    try { off = new URLSearchParams(location.search).get("rebrand") === "0"; } catch (e) {}
    if (off) return;
    var PYPI_URL = ${JSON.stringify(PYPI_QWENPAW_URL)};
    var PINNED_VERSION = ${JSON.stringify(PINNED_QWENPAW_VERSION)};
    var DOC_ORIGIN = ${JSON.stringify(UPSTREAM_DOC_ORIGIN)};
    var GITHUB_URL = ${JSON.stringify(UPSTREAM_GITHUB_URL)};
    try {
      var nativeFetch = window.fetch;
      if (typeof nativeFetch === "function") {
        window.fetch = function (input, init) {
          try {
            var u = typeof input === "string" ? input : (input && input.url) || "";
            if (u === PYPI_URL) {
              return Promise.resolve(new Response(JSON.stringify({ info: { version: PINNED_VERSION } }), { status: 200, headers: { "Content-Type": "application/json" } }));
            }
          } catch (e) {}
          return nativeFetch.apply(this, arguments);
        };
      }
    } catch (e) {}
    try {
      var nativeOpen = window.open;
      if (typeof nativeOpen === "function") {
        window.open = function (url) {
          try {
            var u = String(url || "");
            if (u.indexOf(DOC_ORIGIN) === 0 || u.indexOf(GITHUB_URL) === 0) return null;
          } catch (e) {}
          return nativeOpen.apply(this, arguments);
        };
      }
    } catch (e) {}
  } catch (e) { /* never break the console */ }
})();
</script>`;
}

/**
 * The floating "Computer" launcher injected into the console SPA.
 *
 * History, because it explains the shape: the previous version of this script
 * mounted a preview iframe and called `/desktop/__mode`, `/desktop/__status`
 * and `/desktop/__screen` — endpoints that went away with the computer
 * rebuild. It was deleted along with them, leaving `proxy()` calling a
 * function that no longer existed. That is the second ReferenceError this
 * file had, and neither was caught because nothing ever *loaded* the Worker.
 *
 * This version does one small thing: a button that opens the rebuilt
 * `/computer` surface in a 316 px rail beside the chat, which is what the
 * new UI is designed for (`?embed=1` hides its own stage and overlay).
 * Nothing here reaches into the SPA beyond appending a sibling of #root, so
 * React re-renders cannot remove it. Every failure is swallowed: an
 * injection bug must never break the console.
 */
function computerPanelScript(rebrandEnabled) {
  return `<script>
(function () {
  var AGENTX_REBRAND_ENABLED = ${rebrandEnabled ? "true" : "false"};
  var AGENTX_UPSTREAM_DOC = ${JSON.stringify(UPSTREAM_DOC_ORIGIN)};
  var AGENTX_UPSTREAM_GITHUB = ${JSON.stringify(UPSTREAM_GITHUB_URL)};
  try {
    if (!document.getElementById("root")) return;
    if (document.getElementById("qwenpawComputerBtn")) return;
    var btn = document.createElement("button");
    btn.id = "qwenpawComputerBtn";
    btn.type = "button";
    btn.textContent = "Computer";
    btn.title = "AgentX's computer — watch and drive the live desktop";
    btn.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:150px;box-sizing:border-box;text-align:center;padding:10px 16px;border-radius:999px;border:1px solid #343945;background:#171a21;color:#e8eaf0;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45);";

    // ---- Rest button ----
    // Deliberately a visible button next to "Computer", NOT a menu item: the
    // whole point is that the user can rest the machine in one click when they
    // are done. Hiding it in a submenu is how a feature gets forgotten.
    //
    // It is only meaningful while the machine is running, so the label reflects
    // state: "Rest machine" when up, "Resting" (disabled) when already rested.
    // A click never happens by accident: it asks once, then posts with the
    // console's own bearer token. If that token is missing the Worker refuses,
    // and the button says so rather than pretending.
    var restBtn = document.createElement("button");
    restBtn.id = "qwenpawRestBtn";
    restBtn.type = "button";
    restBtn.textContent = "Rest machine";
    restBtn.title = "Send the machine to rest when you are done — opening the site wakes it again";
    restBtn.style.cssText = "position:fixed;right:16px;bottom:64px;z-index:2147483647;width:150px;box-sizing:border-box;text-align:center;padding:10px 16px;border-radius:999px;border:1px solid #34404f;background:#171a21;color:#c8d1dc;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45);";

    // ---- Vault button ----
    // The vault (an API-key store the agent can use but never see) lives at
    // /vault, but nothing in the console linked to it — the user could not
    // find it. A visible button next to Computer/Rest, same pattern, opens
    // the vault page in a new tab. No token needed here: /vault mints its
    // own session from the console's sign-in, like /computer does.
    var vaultBtn = document.createElement("button");
    vaultBtn.id = "qwenpawVaultBtn";
    vaultBtn.type = "button";
    vaultBtn.textContent = "Vault";
    vaultBtn.title = "API-key vault — keys the agent can use but never see";
    vaultBtn.style.cssText = "position:fixed;right:16px;bottom:112px;z-index:2147483647;width:150px;box-sizing:border-box;text-align:center;padding:10px 16px;border-radius:999px;border:1px solid #343945;background:#171a21;color:#e8eaf0;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45);";

    var panel = document.createElement("div");
    panel.id = "qwenpawComputerPanel";
    panel.style.cssText = "position:fixed;top:0;right:0;bottom:0;width:316px;max-width:100vw;z-index:2147483646;background:#0f1115;border-left:1px solid #262a33;display:none;flex-direction:column;box-shadow:-12px 0 32px rgba(0,0,0,.4);";

    var bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:8px;height:44px;padding:0 10px;background:#171a21;border-bottom:1px solid #262a33;color:#e8eaf0;font:600 13px system-ui,sans-serif;flex:none;";
    bar.innerHTML = "<span style='flex:1'>Computer</span>" +
      "<a href='/computer' target='_blank' rel='noopener' style='color:#86efac;text-decoration:none'>Open full</a>" +
      "<button id='qwenpawComputerClose' type='button' aria-label='Close computer' style='background:none;border:none;color:#e8eaf0;font-size:18px;cursor:pointer;padding:4px 8px'>&times;</button>";

    var frame = document.createElement("iframe");
    frame.id = "qwenpawComputerFrame";
    frame.title = "Computer";
    frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock allow-popups allow-same-origin");
    frame.setAttribute("allow", "clipboard-read; clipboard-write");
    frame.style.cssText = "flex:1;width:100%;border:0;background:#000;";
    // Loaded lazily: an iframe created on every console page view would open a
    // screen session nobody asked for, and every one of those is a request.
    panel.appendChild(bar);
    panel.appendChild(frame);
    document.body.appendChild(panel);
    document.body.appendChild(btn);
    document.body.appendChild(restBtn);
    document.body.appendChild(vaultBtn);
    vaultBtn.addEventListener("click", function () {
      // The floating Vault pill opens the full Vault page (where the
      // user sees and manages existing keys), not the in-chat add-key
      // dialog — QA round 3: the pill opening only an empty "Add a
      // key" form read as the wrong destination. The add-key dialog
      // stays reachable from the Vault menu item and from /vault.
      window.open("/vault", "_blank", "noopener");
    });

    // ---- Vault add-key popup (in-chat) ----
    // The Vault button and the Vault menu item open a secure box right in
    // the chat — the connector-popup pattern — instead of navigating away
    // to /vault. The form posts to the same /vault/put endpoint the /vault
    // page uses, with the same session handling (ensureSession + 401
    // retry). The value lives only in the password input and is wiped on
    // close and after a save. The full /vault page stays one click away
    // (the "Open the full Vault page" link) for managing existing keys.
    var vaultPopupEl = null;
    function vaultPopupToken() {
      try {
        var v = localStorage.getItem("qwenpaw_auth_token");
        if (v && v.length > 8) return v;
      } catch (e) {}
      return consoleToken();
    }
    async function vaultPopupEnsureSession() {
      try {
        var already = await fetch("/api/session/state", { cache: "no-store", credentials: "same-origin" });
        var st = await already.json().catch(function () { return {}; });
        if (st && st.ok) return true;
      } catch (e) {}
      var token = vaultPopupToken();
      if (!token) return false;
      try {
        var res = await fetch("/api/session/mint", {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
          credentials: "same-origin",
          cache: "no-store",
        });
        return res.ok;
      } catch (e) { return false; }
    }
    async function vaultPopupApi(body) {
      var doFetch = function () {
        return fetch("/vault/put", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "same-origin",
          cache: "no-store",
        });
      };
      var res = await doFetch();
      if (res.status === 401) {
        var ok = await vaultPopupEnsureSession();
        if (ok) res = await doFetch();
      }
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { ok: res.ok, status: res.status, data: data };
    }
    function vaultPopupSyncKind() {
      var kind = document.getElementById("qwenpawVaultPopupKind").value;
      document.getElementById("qwenpawVaultPopupOriginRow").style.display = kind === "command" ? "none" : "";
      document.getElementById("qwenpawVaultPopupHeaderRow").style.display = kind === "header" ? "" : "none";
      document.getElementById("qwenpawVaultPopupUserRow").style.display = kind === "basic" ? "" : "none";
      document.getElementById("qwenpawVaultPopupOrigin").required = kind !== "command";
    }
    // ---- Vault provider presets ----
    // Picking a provider fills in the kind, the origin and the header name
    // (and suggests a name and a title when those are still empty), so
    // adding a key is just: pick a provider, type a name, paste the key.
    // "Custom" is the default and leaves every field alone, for a
    // provider that is not listed. Pasting an origin that matches a
    // preset picks that provider by itself. The same list lives in
    // pages/public/vault/vault.js for the /vault page — keep them in
    // sync. Origins are bare origins (no path): the router pins the key
    // to exactly this origin. Providers that need an extra header the
    // request endpoint cannot send yet (Anthropic needs anthropic-version,
    // Notion needs Notion-Version, Linear uses a bare key, not Bearer)
    // are deliberately NOT listed — use Custom for those for now.
    var VAULT_PROVIDER_PRESETS = [
      { key: "custom", label: "Custom — enter the details yourself", kind: "", origin: "", headerName: "", name: "", title: "" },
      { key: "cloudflare", label: "Cloudflare", kind: "bearer", origin: "https://api.cloudflare.com", headerName: "", name: "cloudflare", title: "Cloudflare API token" },
      { key: "deepseek", label: "DeepSeek", kind: "bearer", origin: "https://api.deepseek.com", headerName: "", name: "deepseek", title: "DeepSeek API key" },
      { key: "github", label: "GitHub", kind: "bearer", origin: "https://api.github.com", headerName: "", name: "github", title: "GitHub personal access token" },
      { key: "gemini", label: "Google Gemini", kind: "header", origin: "https://generativelanguage.googleapis.com", headerName: "x-goog-api-key", name: "gemini", title: "Google Gemini API key" },
      { key: "groq", label: "Groq", kind: "bearer", origin: "https://api.groq.com", headerName: "", name: "groq", title: "Groq API key" },
      { key: "huggingface", label: "Hugging Face", kind: "bearer", origin: "https://huggingface.co", headerName: "", name: "huggingface", title: "Hugging Face token" },
      { key: "mistral", label: "Mistral", kind: "bearer", origin: "https://api.mistral.ai", headerName: "", name: "mistral", title: "Mistral API key" },
      { key: "openai", label: "OpenAI", kind: "bearer", origin: "https://api.openai.com", headerName: "", name: "openai", title: "OpenAI API key" },
      { key: "openrouter", label: "OpenRouter", kind: "bearer", origin: "https://openrouter.ai", headerName: "", name: "openrouter", title: "OpenRouter API key" },
      { key: "slack", label: "Slack", kind: "bearer", origin: "https://slack.com", headerName: "", name: "slack", title: "Slack bot token" },
      { key: "xai", label: "xAI", kind: "bearer", origin: "https://api.x.ai", headerName: "", name: "xai", title: "xAI API key" },
    ];
    function vaultPopupFindPreset(key) {
      for (var i = 0; i < VAULT_PROVIDER_PRESETS.length; i++) {
        if (VAULT_PROVIDER_PRESETS[i].key === key) return VAULT_PROVIDER_PRESETS[i];
      }
      return null;
    }
    function vaultPopupFindPresetByOrigin(origin) {
      var o = (origin || "").trim().toLowerCase();
      if (!o) return null;
      for (var i = 0; i < VAULT_PROVIDER_PRESETS.length; i++) {
        var p = VAULT_PROVIDER_PRESETS[i];
        if (p.origin && p.origin.toLowerCase() === o) return p;
      }
      return null;
    }
    function vaultPopupApplyProvider() {
      var sel = document.getElementById("qwenpawVaultPopupProvider");
      var p = vaultPopupFindPreset(sel.value);
      if (!p || p.key === "custom") return;
      document.getElementById("qwenpawVaultPopupKind").value = p.kind;
      document.getElementById("qwenpawVaultPopupOrigin").value = p.origin;
      if (p.kind === "header") document.getElementById("qwenpawVaultPopupHeader").value = p.headerName;
      var nameEl = document.getElementById("qwenpawVaultPopupName");
      if (!nameEl.value.trim() && p.name) nameEl.value = p.name;
      var titleEl = document.getElementById("qwenpawVaultPopupTitle");
      if (!titleEl.value.trim() && p.title) titleEl.value = p.title;
      vaultPopupSyncKind();
    }
    function vaultPopupDetectProvider() {
      var origin = document.getElementById("qwenpawVaultPopupOrigin").value;
      var p = vaultPopupFindPresetByOrigin(origin);
      var sel = document.getElementById("qwenpawVaultPopupProvider");
      if (p && sel.value !== p.key) {
        sel.value = p.key;
        vaultPopupApplyProvider();
      } else if (!p && sel.value !== "custom") {
        sel.value = "custom";
      }
    }
    function closeVaultPopup() {
      if (!vaultPopupEl) return;
      try {
        var v = document.getElementById("qwenpawVaultPopupValue");
        if (v) v.value = "";
      } catch (e) {}
      vaultPopupEl.style.display = "none";
    }
    async function vaultPopupSave() {
      var msg = document.getElementById("qwenpawVaultPopupMsg");
      var name = document.getElementById("qwenpawVaultPopupName").value.trim();
      var kind = document.getElementById("qwenpawVaultPopupKind").value;
      var value = document.getElementById("qwenpawVaultPopupValue").value;
      msg.style.color = "#b91c1c";
      msg.textContent = "";
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
        msg.textContent = "Name must start with a lowercase letter and use only a-z, 0-9, - and _ (up to 64 chars).";
        return;
      }
      if (!value) { msg.textContent = "Paste the key value."; return; }
      var body = {
        name: name, kind: kind,
        origin: kind === "command" ? undefined : document.getElementById("qwenpawVaultPopupOrigin").value.trim(),
        headerName: kind === "header" ? document.getElementById("qwenpawVaultPopupHeader").value.trim() : undefined,
        username: kind === "basic" ? document.getElementById("qwenpawVaultPopupUser").value.trim() : undefined,
        value: value,
        title: document.getElementById("qwenpawVaultPopupTitle").value.trim(),
        note: document.getElementById("qwenpawVaultPopupNote").value.trim(),
      };
      var saveBtn = document.getElementById("qwenpawVaultPopupSave");
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        var r = await vaultPopupApi(body);
        if (!r.ok) {
          var detail = r.data && r.data.error ? r.data.error : "";
          if (r.data && r.data.detail) detail += " — " + r.data.detail;
          msg.textContent = "Could not save (" + r.status + (detail ? ": " + detail : "") + ").";
          return;
        }
        msg.style.color = "#15803d";
        msg.textContent = "Saved " + name + ". The agent can use it now.";
        document.getElementById("qwenpawVaultPopupValue").value = "";
        setTimeout(function () { closeVaultPopup(); }, 1200);
      } catch (e) {
        msg.textContent = "Could not reach the server — check your connection and retry.";
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save key";
      }
    }
    function openVaultPopup() {
      try {
        if (!vaultPopupEl) {
          var back = document.createElement("div");
          back.id = "qwenpawVaultPopup";
          back.setAttribute("data-qwenpaw-vault-popup", "1");
          back.style.cssText = "position:fixed;inset:0;background:rgba(15,17,21,0.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;";
          back.innerHTML =
            '<div style="background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,0.35);width:min(480px,92vw);max-height:90vh;overflow:auto;padding:24px;font-family:system-ui,sans-serif;color:#1a1d24;">' +
            '<h2 style="margin:0 0 4px;font-size:18px;">Add a key to the Vault</h2>' +
            '<p style="margin:0 0 16px;font-size:13px;color:#5b6470;">Keys the agent can use but never see. The value is sealed on the server and never shown again.</p>' +
            '<label style="display:block;font-size:13px;margin-bottom:10px;">Provider<br><select id="qwenpawVaultPopupProvider" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></select></label>' +
            '<label style="display:block;font-size:13px;margin-bottom:10px;">Name<br><input id="qwenpawVaultPopupName" type="text" placeholder="e.g. github-main" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label style="display:block;font-size:13px;margin-bottom:10px;">Kind<br><select id="qwenpawVaultPopupKind" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"><option value="bearer">API key (Authorization: Bearer)</option><option value="header">Custom header</option><option value="basic">Username + password</option><option value="command">Command / CLI env var</option></select></label>' +
            '<label id="qwenpawVaultPopupOriginRow" style="display:block;font-size:13px;margin-bottom:10px;">Origin<br><input id="qwenpawVaultPopupOrigin" type="text" placeholder="https://api.github.com" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label id="qwenpawVaultPopupHeaderRow" style="display:none;font-size:13px;margin-bottom:10px;">Header name<br><input id="qwenpawVaultPopupHeader" type="text" placeholder="X-Api-Key" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label id="qwenpawVaultPopupUserRow" style="display:none;font-size:13px;margin-bottom:10px;">Username<br><input id="qwenpawVaultPopupUser" type="text" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label style="display:block;font-size:13px;margin-bottom:10px;">Value<br><input id="qwenpawVaultPopupValue" type="password" autocomplete="off" placeholder="Paste the key here" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label style="display:block;font-size:13px;margin-bottom:10px;">Title (optional)<br><input id="qwenpawVaultPopupTitle" type="text" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label style="display:block;font-size:13px;margin-bottom:14px;">Note (optional)<br><input id="qwenpawVaultPopupNote" type="text" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<div id="qwenpawVaultPopupMsg" style="font-size:13px;min-height:18px;margin-bottom:10px;"></div>' +
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
            '<button id="qwenpawVaultPopupSave" type="button" style="background:#f97316;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;">Save key</button>' +
            '<button id="qwenpawVaultPopupCancel" type="button" style="background:#f1f2f4;color:#1a1d24;border:none;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer;">Cancel</button>' +
            '<a id="qwenpawVaultPopupOpen" href="#" style="font-size:13px;color:#2563eb;">Open the full Vault page</a>' +
            '</div></div>';
          document.body.appendChild(back);
          vaultPopupEl = back;
          back.addEventListener("click", function (e) { if (e.target === back) closeVaultPopup(); });
          document.getElementById("qwenpawVaultPopupKind").addEventListener("change", vaultPopupSyncKind);
          // Populate the provider select from the preset list (kept in
          // sync with the /vault page) and wire autofill + auto-detect.
          var provSel = document.getElementById("qwenpawVaultPopupProvider");
          for (var pi = 0; pi < VAULT_PROVIDER_PRESETS.length; pi++) {
            var opt = document.createElement("option");
            opt.value = VAULT_PROVIDER_PRESETS[pi].key;
            opt.textContent = VAULT_PROVIDER_PRESETS[pi].label;
            provSel.appendChild(opt);
          }
          provSel.value = "custom";
          provSel.addEventListener("change", vaultPopupApplyProvider);
          document.getElementById("qwenpawVaultPopupOrigin").addEventListener("input", vaultPopupDetectProvider);
          document.getElementById("qwenpawVaultPopupSave").addEventListener("click", vaultPopupSave);
          document.getElementById("qwenpawVaultPopupCancel").addEventListener("click", closeVaultPopup);
          document.getElementById("qwenpawVaultPopupOpen").addEventListener("click", function (e) {
            e.preventDefault();
            window.open("/vault", "_blank", "noopener");
          });
          document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && vaultPopupEl && vaultPopupEl.style.display !== "none") closeVaultPopup();
          });
        }
        document.getElementById("qwenpawVaultPopupMsg").textContent = "";
        document.getElementById("qwenpawVaultPopupMsg").style.color = "#b91c1c";
        vaultPopupEl.style.display = "flex";
        vaultPopupSyncKind();
        document.getElementById("qwenpawVaultPopupName").focus();
      } catch (e) { /* never break the console */ }
    }

    // ---- rest button behaviour ----
    // The console keeps its session token in localStorage; read it directly
    // rather than scraping a header, so this works on any console page.
    function consoleToken() {
      try {
        var keys = ["token", "qwenpaw_token", "qwenpaw-token", "access_token"];
        for (var i = 0; i < keys.length; i++) {
          var v = localStorage.getItem(keys[i]);
          if (v && v.length > 8) return v;
        }
        // Some builds store a JSON blob.
        for (var j = 0; j < localStorage.length; j++) {
          var k = localStorage.key(j);
          var raw = localStorage.getItem(k);
          if (!raw || raw.length < 8) continue;
          try {
            var o = JSON.parse(raw);
            if (o && typeof o === "object") {
              var t = o.token || o.access_token || o.accessToken;
              if (typeof t === "string" && t.length > 8) return t;
            }
          } catch (e) { /* not JSON */ }
        }
      } catch (e) { /* storage blocked */ }
      return "";
    }

    var resting = false;
    function paintRest() {
      restBtn.textContent = resting ? "Resting" : "Rest machine";
      restBtn.disabled = resting;
      restBtn.style.opacity = resting ? "0.6" : "1";
      restBtn.style.cursor = resting ? "default" : "pointer";
    }
    function toastRest(text, bad) {
      var t = document.createElement("div");
      t.textContent = text;
      t.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;"
        + "background:" + (bad ? "#3a1d22" : "#1b2130") + ";border:1px solid " + (bad ? "#5a2a31" : "#2a3346")
        + ";color:" + (bad ? "#ffb4b4" : "#e8eaf0") + ";border-radius:10px;padding:10px 16px;"
        + "font:600 13px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:80vw;";
      document.body.appendChild(t);
      setTimeout(function () { try { t.remove(); } catch (e) {} }, 6000);
    }
    restBtn.addEventListener("click", async function () {
      if (resting) return;
      if (!window.confirm("Send the machine to rest? Open the site again to wake it.")) return;
      restBtn.textContent = "Resting…";
      restBtn.disabled = true;
      try {
        var tok = consoleToken();
        var r = await fetch("/api/machine/rest", {
          method: "POST",
          headers: tok ? { Authorization: "Bearer " + tok } : {},
        });
        var j = null;
        try { j = await r.json(); } catch (e) { j = null; }
        if (r.ok && j && j.ok) {
          resting = true;
          paintRest();
          toastRest(j.message || "Machine resting — open the site again to wake it.");
          return;
        }
        // Every refusal has a reason worth showing; guess nothing.
        var why = (j && (j.error || j.detail)) || ("HTTP " + r.status);
        if (j && j.error === "auth_required") why = "Sign in to the console first, then rest the machine.";
        if (j && j.error === "instabox_api_key_unset") why = "Rest is not configured yet (INSTABOX_API_KEY missing).";
        if (j && j.error === "machine_not_running") why = "The machine is already paused.";
        toastRest(String(why), true);
        paintRest();
      } catch (e) {
        toastRest("Could not reach the machine: " + (e && e.message ? e.message : "network"), true);
        paintRest();
      }
    });
    // Reflect an existing rest on load, so a page reload does not offer to rest
    // a machine that is already resting.
    (async function initRest() {
      try {
        var r = await fetch("/api/machine/state");
        var j = await r.json();
        resting = !!(j && j.resting);
        paintRest();
      } catch (e) { /* leave the default label */ }
    })();

    var open = false;
    try { open = sessionStorage.getItem("qwenpawComputerOpen") === "1"; } catch (e) {}

    function setOpen(v) {
      open = !!v;
      panel.style.display = open ? "flex" : "none";
      // When the 316 px panel is open it covers the right edge, and the
      // pills (max z-index) would sit on top of it — the Computer pill
      // over the panel's own content. Shift the whole column left of
      // the panel while it is open, back to the edge when it closes.
      // Also lift the column above the composer while the panel is open
      // (QA round 3): at the bottom edge, shifted left, the pills sat
      // on the composer's Send button and the toolbar's right end.
      // Lifted to 200/248/296 (QA round 4): the 140/188/236 lift still
      // left the bottom pill overlapping the blue banner and the
      // input box's top-right corner (the composer is ~150px tall
      // including the banner, so the pills must clear ~200px).
      var right = open ? "332px" : "16px";
      btn.style.right = right;
      restBtn.style.right = right;
      vaultBtn.style.right = right;
      btn.style.bottom = open ? "380px" : "16px";
      restBtn.style.bottom = open ? "428px" : "64px";
      vaultBtn.style.bottom = open ? "476px" : "112px";
      if (open && !frame.getAttribute("src")) frame.setAttribute("src", "/computer?embed=1");
      try { sessionStorage.setItem("qwenpawComputerOpen", open ? "1" : "0"); } catch (e) {}
    }
    btn.addEventListener("click", function () { setOpen(!open); });
    document.getElementById("qwenpawComputerClose").addEventListener("click", function () { setOpen(false); });
    setOpen(open);

    // ---- Vault item in the account menu ----
    // The account dropdown (Avatar manager, Appearance, Message display,
    // Settings, ...) is the console's own React dialog (role="dialog",
    // named "Settings"), rendered as a portal at the end of the document
    // and rebuilt every time it opens. A one-off insert would vanish on
    // the next open, so a MutationObserver re-inserts the item on every
    // open.
    //
    // The item is a CLONE of the "Settings" button, not a fresh element:
    // cloning copies the exact classes, so it looks identical to the other
    // items without guessing class names. Only the icon (a lock) and the
    // label ("Vault") change. cloneNode copies attributes, not listeners,
    // so the click is ours alone. Inserted right after "Settings" in the
    // first group.
    function findSettingsDialog() {
      var d = document.querySelector('[role="dialog"][aria-label="Settings"]');
      if (d) return d;
      var dialogs = document.querySelectorAll('[role="dialog"]');
      for (var i = 0; i < dialogs.length; i++) {
        var btns = dialogs[i].querySelectorAll("button");
        for (var j = 0; j < btns.length; j++) {
          if ((btns[j].textContent || "").trim() === "Settings") return dialogs[i];
        }
      }
      return null;
    }
    function addVaultMenuItem() {
      try {
        var dialog = findSettingsDialog();
        if (!dialog) return;
        if (dialog.querySelector("[data-qwenpaw-vault-menu]")) return;
        var buttons = dialog.querySelectorAll("button");
        var settingsBtn = null;
        for (var i = 0; i < buttons.length; i++) {
          if ((buttons[i].textContent || "").trim() === "Settings") { settingsBtn = buttons[i]; break; }
        }
        if (!settingsBtn) return;
        var item = settingsBtn.cloneNode(true);
        item.setAttribute("data-qwenpaw-vault-menu", "1");
        // Swap the gear for a lock. Keep the svg element (its classes size
        // it); only the paths change. Line-style icon, 24x24 like the rest.
        var svg = item.querySelector("svg");
        if (svg) {
          svg.setAttribute("viewBox", "0 0 24 24");
          svg.setAttribute("fill", "none");
          svg.setAttribute("stroke", "currentColor");
          svg.innerHTML = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>';
        }
        // Relabel. Prefer a bare text node reading "Settings"; else a child
        // element holding the label. If neither is found, do not insert —
        // a second "Settings" would be worse than no Vault item.
        var relabeled = false;
        for (var j = 0; j < item.childNodes.length; j++) {
          var n = item.childNodes[j];
          if (n.nodeType === 3 && (n.textContent || "").trim() === "Settings") {
            n.textContent = "Vault";
            relabeled = true;
            break;
          }
        }
        if (!relabeled) {
          var kids = item.querySelectorAll("*");
          for (var k = 0; k < kids.length; k++) {
            if ((kids[k].textContent || "").trim() === "Settings" && !kids[k].querySelector("svg")) {
              kids[k].textContent = "Vault";
              relabeled = true;
              break;
            }
          }
        }
        if (!relabeled) return;
        item.addEventListener("click", function () {
          try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (e) {}
          openVaultPopup();
        });
        settingsBtn.parentNode.insertBefore(item, settingsBtn.nextSibling);
      } catch (e) { /* never break the console */ }
    }
    // ---- AgentX rebrand (DOM injection, 2026-11-18) ----
    // The product is AgentX; the upstream console still calls itself
    // QwenPaw. The rename is done here, in the browser, by the same
    // MutationObserver that re-inserts the Vault item — never by rewriting
    // the bundle (immutable, cache-pinned for a year). Worst failure of any
    // rule below is a stale label, never a broken console: every rule runs
    // in its own try/catch, and the whole pass is throttled (leading +
    // trailing, 400 ms) so React re-renders cannot make it a hot loop.
    //
    // NEVER-RENAME allowlist (features/rebrand/README.md): localStorage keys
    // (qwenpaw_auth_token, qwenpaw-agent-storage, qwenpaw-last-used-agent),
    // qwenpaw:* events, the qwenpaw- CSS prefix, QWENPAW_AUTH_ENABLED, the
    // ~/.qwenpaw path, API paths, and the literal pip commands
    // (Install qwenpaw[codex], uv pip install 'qwenpaw[whisper]'). The text
    // pass skips any node whose own or parent text contains one of those
    // load-bearing strings, so setup instructions stay truthful. The
    // multi-window safety prompts ("Close QwenPaw?", "still in use in
    // other windows") are NOT hidden — only their product name is renamed.
    // Kill switches: worker env AGENTX_REBRAND=0 (bakes the flag false) or
    // ?rebrand=0 in the page URL (checked at runtime).
    /* AGENTX-REBRAND-START */
    var AGENTX_MENU_LABELS = ["Tutorial", "Feature Demos", "Changelog", "FAQ", "GitHub", "Documentation", "Import"];
    var AGENTX_CHINA_LABELS = ["DashScope", "SiliconFlow", "ModelScope", "Alibaba", "Alibaba Cloud", "Aliyun", "WeCom", "DingTalk", "Feishu", "QQ", "WeChat", "XiaoYi", "Yuanbao"];
    var AGENTX_LOAD_BEARING = ["qwenpaw[codex]", "qwenpaw[whisper]", "QWENPAW_AUTH_ENABLED", "~/.qwenpaw", "qwenpaw_auth_token", "qwenpaw-agent-storage", "qwenpaw-last-used-agent", "qwenpaw:", "qwenpaw-"];
    var agentxLinkBlockerInstalled = false;
    var agentxLastRun = 0;
    var agentxTrailingTimer = null;
    function agentxRebrandOff() {
      if (!AGENTX_REBRAND_ENABLED) return true;
      try { return new URLSearchParams(location.search).get("rebrand") === "0"; } catch (e) { return false; }
    }
    function agentxIsLoadBearing(text) {
      if (!text) return false;
      for (var i = 0; i < AGENTX_LOAD_BEARING.length; i++) {
        if (text.indexOf(AGENTX_LOAD_BEARING[i]) !== -1) return true;
      }
      return false;
    }
    function agentxRenameTextIn(root) {
      var walker;
      try { walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null); } catch (e) { return 0; }
      var changed = 0;
      var node;
      while ((node = walker.nextNode())) {
        try {
          var t = node.nodeValue;
          if (!t || t.indexOf("QwenPaw") === -1) continue;
          var parent = node.parentNode;
          if (parent && (parent.nodeName === "SCRIPT" || parent.nodeName === "STYLE" || parent.nodeName === "TEXTAREA" || parent.nodeName === "INPUT")) continue;
          if (agentxIsLoadBearing(t)) continue;
          if (parent && parent.textContent && agentxIsLoadBearing(parent.textContent)) continue;
          node.nodeValue = t.split("QwenPaw").join("AgentX");
          changed += 1;
        } catch (e) {}
      }
      return changed;
    }
    function agentxHideExact(label, itemSelector, ancestorSelector) {
      var found = 0;
      var els;
      try { els = document.querySelectorAll(itemSelector); } catch (e) { return 0; }
      for (var i = 0; i < els.length; i++) {
        try {
          var el = els[i];
          if (el.children && el.children.length) continue;
          if ((el.textContent || "").trim() !== label) continue;
          var target = el;
          try {
            var anc = el.closest ? el.closest(ancestorSelector) : null;
            if (anc) target = anc;
          } catch (e) {}
          if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
          target.style.display = "none";
          if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          found += 1;
        } catch (e) {}
      }
      return found;
    }
    function agentxHideAncestorByContent(substring, itemSelector, ancestorSelector) {
      var found = 0;
      var els;
      try { els = document.querySelectorAll(itemSelector); } catch (e) { return 0; }
      for (var i = 0; i < els.length; i++) {
        try {
          var el = els[i];
          if ((el.textContent || "").indexOf(substring) === -1) continue;
          var target = null;
          try { target = el.closest ? el.closest(ancestorSelector) : null; } catch (e) {}
          if (!target) target = el.parentNode && el.parentNode.parentNode ? el.parentNode.parentNode : el;
          if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
          target.style.display = "none";
          if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          found += 1;
        } catch (e) {}
      }
      return found;
    }
    // Climb from a matched element to the container that must be hidden
    // (the button / card / menu item itself, not just the name inside it).
    // Fix 2026-11-18 (browser verification): agentxHideExact only hid the
    // leaf that held the label, so icon-only buttons and provider cards
    // survived as unnamed shells. closest() with the container selector is
    // tried first; when the container carries no matching class, walk up a
    // few levels for a card/item-like ancestor, or for the ancestor that is
    // a direct child of a list/grid (that ancestor IS the card). Returns
    // null when no container is found, so the caller hides the element.
    function agentxClimbToContainer(el, containerSelector) {
      var target = null;
      try { target = el.closest ? el.closest(containerSelector) : null; } catch (e) {}
      if (target) return target;
      var cur = el.parentNode;
      for (var depth = 0; cur && cur.nodeType === 1 && depth < 6; depth++) {
        try {
          var cls = "";
          try { cls = (cur.getAttribute("class") || "").toLowerCase(); } catch (e) {}
          var role = "";
          try { role = cur.getAttribute("role") || ""; } catch (e) {}
          var tag = (cur.tagName || "").toLowerCase();
          if (tag === "li" || role === "listitem" ||
              cls.indexOf("card") !== -1 || cls.indexOf("item") !== -1 ||
              cls.indexOf("listitem") !== -1 || cls.indexOf("provider") !== -1 ||
              cls.indexOf("model") !== -1 || cls.indexOf("channel") !== -1) {
            return cur;
          }
          var parent = cur.parentNode;
          if (parent && parent.nodeType === 1) {
            var pCls = "";
            try { pCls = (parent.getAttribute("class") || "").toLowerCase(); } catch (e) {}
            var pRole = "";
            try { pRole = parent.getAttribute("role") || ""; } catch (e) {}
            var pTag = (parent.tagName || "").toLowerCase();
            if (pRole === "list" || pTag === "ul" || pTag === "ol" ||
                pCls.indexOf("list") !== -1 || pCls.indexOf("grid") !== -1) {
              return cur;
            }
          }
        } catch (e) {}
        cur = cur.parentNode;
      }
      return null;
    }
    // Climb from a matched China name to the CARD that must be hidden —
    // never the list that holds all the cards. Fix 2026-11-18 (live
    // browser re-verification): the old climb hid the WHOLE provider
    // list. Root cause, proven by replaying the real card DOM in the
    // harness: the provider card's class is a hashed CSS module,
    // "index-module__groupCardGlass__-GYEf" — "Card" with a capital C —
    // so the case-sensitive [class*='card'] never matched the card,
    // while [class*='provider'] matched the LIST container
    // "index-module__providerCards__fYCGM" and closest() climbed past
    // the card to the list. The settled page then showed no provider
    // cards at all (the transient snapshots caught the list before the
    // rule ran); SiliconFlow / ModelScope / Aliyun were never hidden as
    // cards. This climb is structural and case-insensitive: the card is
    // the ancestor that is a direct child of the list/grid (the provider
    // list, the channel grid, a role=list, a ul/ol), or — failing that —
    // the first ancestor whose lowercased class names the card itself
    // (groupCardGlass = provider card, channelCard = configured channel
    // card, availableItem = available-channel button), skipping the
    // name-bearing leaves (groupCardName / cardTitle / availableItemName).
    // The list/grid container itself is never returned, so non-China
    // providers (OpenAI, Anthropic, DeepSeek, ...) are never hidden
    // with it. Returns null when no card is found, so the caller hides
    // the matched element itself.
    function agentxClimbToChinaCard(el) {
      var cur = el;
      for (var depth = 0; cur && cur.nodeType === 1 && depth < 8; depth++) {
        var parent = cur.parentNode;
        if (parent && parent.nodeType === 1) {
          var pCls = "";
          try { pCls = (parent.getAttribute("class") || "").toLowerCase(); } catch (e) {}
          var pRole = "";
          try { pRole = parent.getAttribute("role") || ""; } catch (e) {}
          var pTag = (parent.tagName || "").toLowerCase();
          if (pCls.indexOf("providercards") !== -1 || pCls.indexOf("availablegrid") !== -1 ||
              pCls.indexOf("channelsgrid") !== -1 || pRole === "list" ||
              pTag === "ul" || pTag === "ol" ||
              pCls.indexOf("list") !== -1 || pCls.indexOf("grid") !== -1) {
            return cur;
          }
        }
        cur = parent;
      }
      cur = el;
      for (var d2 = 0; cur && cur.nodeType === 1 && d2 < 8; d2++) {
        var cls = "";
        try { cls = (cur.getAttribute("class") || "").toLowerCase(); } catch (e) {}
        if (cls.indexOf("providercards") !== -1 || cls.indexOf("availablegrid") !== -1 ||
            cls.indexOf("channelsgrid") !== -1) { cur = cur.parentNode; continue; }
        if (cls.indexOf("groupcardname") !== -1 || cls.indexOf("cardtitle") !== -1 ||
            cls.indexOf("availableitemname") !== -1) { cur = cur.parentNode; continue; }
        if (cls.indexOf("groupcardglass") !== -1 || cls.indexOf("channelcard") !== -1 ||
            cls.indexOf("availableitem") !== -1) {
          return cur;
        }
        cur = cur.parentNode;
      }
      return null;
    }
    // Hide every element whose ACCESSIBLE NAME matches a label — not just
    // elements whose visible text equals it. Fix 2026-11-18 (browser
    // verification): the header Documentation/GitHub buttons and the five
    // Settings-menu icon buttons have no text at all, only an accessible
    // name (aria-label / title), and the China channel cards likewise
    // carry the name as an accessible name while showing only an icon +
    // Configure. The name is read from aria-label, then title, then alt
    // (img), then the element's own text. A name from an attribute may
    // match as a whole word ("Open GitHub" matches "GitHub"); a name from
    // text must match exactly, so a container whose text merely contains
    // a label among other items is never hidden. The container found by
    // the climb function is hidden, not the name element alone. The
    // optional climbFn (2026-11-18, hide-china) replaces
    // agentxClimbToContainer for callers whose cards the generic climb
    // cannot find — it must never return a list container.
    // Matching is CASE-INSENSITIVE (fix 2026-11-18, live browser
    // re-verification #3): the XiaoYi channel survived because the label
    // list spelled it "Xiaoyi" while the console renders the display name
    // "XiaoYi" and the channel icon img alt is the lowercase id "xiaoyi"
    // — "Xiaoyi" occurs ZERO times in the live main bundle, so a
    // case-sensitive match could never fire on either path. The other
    // five China channels hide because their display names match the
    // labels exactly; only XiaoYi differs in case. Lowercasing both
    // sides also covers the icon-alt path (alt is always the lowercase
    // channel id) and any future casing drift in a display name.
    function agentxHideByName(labels, itemSelector, containerSelector, climbFn) {
      var found = 0;
      var els;
      try { els = document.querySelectorAll(itemSelector); } catch (e) { return 0; }
      for (var i = 0; i < els.length; i++) {
        try {
          var el = els[i];
          var name = "";
          var fromAttr = false;
          try { name = el.getAttribute("aria-label") || ""; } catch (e) {}
          if (!name) { try { name = el.getAttribute("title") || ""; } catch (e) {} }
          if (!name) { try { name = el.getAttribute("alt") || ""; } catch (e) {} }
          if (name) fromAttr = true;
          if (!name) { try { name = (el.textContent || "").trim(); } catch (e) {} }
          if (!name) continue;
          var matched = false;
          var nameLower = "";
          try { nameLower = name.toLowerCase(); } catch (e) { nameLower = name; }
          for (var j = 0; j < labels.length; j++) {
            var label = labels[j];
            var labelLower = "";
            try { labelLower = label.toLowerCase(); } catch (e) { labelLower = label; }
            if (nameLower === labelLower) { matched = true; break; }
            if (fromAttr) {
              if (label.indexOf(" ") !== -1) {
                if (nameLower.indexOf(labelLower) !== -1) { matched = true; break; }
              } else {
                var words = nameLower.split(/[^a-z0-9]+/);
                for (var k = 0; k < words.length; k++) {
                  if (words[k] === labelLower) { matched = true; break; }
                }
                if (matched) break;
              }
            }
          }
          if (!matched) continue;
          var target = null;
          try {
            target = climbFn ? climbFn(el) : agentxClimbToContainer(el, containerSelector);
          } catch (e) { target = null; }
          if (!target) target = el;
          if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
          target.style.display = "none";
          if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          found += 1;
        } catch (e) {}
      }
      return found;
    }
    // About item click: delegated, capture-phase, on document. Fix
    // 2026-11-18 (browser verification): the old rule attached a listener
    // to a leaf whose text was EXACTLY "About QwenPaw" / "About AgentX",
    // but the real label carries the version ("About QwenPaw v2.3.0"), so
    // it never matched and clicking About only closed the menu. This one
    // matches by PREFIX ("About QwenPaw" / "About AgentX", version suffix
    // allowed) and walks up from the click target, so it works whether the
    // item is a button, an li, or a div, and whether the click lands on
    // the icon, the text, or the row. Capture phase runs before the
    // menu's own handler, so the upstream navigation never happens; the
    // menu is closed with a best-effort Escape keypress (the menu would
    // otherwise stay open, because its own handler never runs).
    var agentxAboutInstalled = false;
    function agentxAboutRule() {
      if (agentxAboutInstalled) return 0;
      try {
        document.addEventListener("click", function (ev) {
          try {
            var cur = ev.target;
            for (var depth = 0; cur && depth < 8; depth++) {
              try {
                if (cur.nodeType === 1) {
                  var t = (cur.textContent || "").trim();
                  if (t && t.length < 40 &&
                      (t.indexOf("About QwenPaw") === 0 || t.indexOf("About AgentX") === 0)) {
                    try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
                    try { window.open("/status", "_blank"); } catch (e) {}
                    try {
                      var esc = null;
                      if (typeof KeyboardEvent === "function") esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
                      else if (document.createEvent) { esc = document.createEvent("Event"); esc.initEvent("keydown", true, true); esc.key = "Escape"; }
                      if (esc) document.dispatchEvent(esc);
                    } catch (e) {}
                    return;
                  }
                }
              } catch (e) {}
              cur = cur.parentNode;
            }
          } catch (e) {}
        }, true);
        agentxAboutInstalled = true;
        return 1;
      } catch (e) { return 0; }
    }
    // Title watcher: rename document.title the moment the app sets it.
    // Fix 2026-11-18 (browser verification): on navigation the title
    // first read "Settings · QwenPaw" and only flipped to AgentX seconds
    // later, because the body MutationObserver only runs the pass when a
    // body mutation happens. A title change does not mutate the body, so
    // the rename waited for the next re-render. This observer watches the
    // <title> element itself, so the rename is immediate. Setting the
    // title inside the callback re-fires the observer, but the title no
    // longer contains "QwenPaw", so it is a no-op, not a loop. A brief
    // flash can still occur if the app sets the title between the
    // observer's microtask and the rename — that is a known limitation,
    // not chased with a timer loop (quota rule: no wall-clock polling).
    var agentxTitleWatcherInstalled = false;
    function agentxWatchTitle() {
      if (agentxTitleWatcherInstalled) return 0;
      try {
        var titleEl = document.querySelector("title");
        if (!titleEl || typeof MutationObserver !== "function") return 0;
        var titleObserver = new MutationObserver(function () {
          try {
            if (document.title && document.title.indexOf("QwenPaw") !== -1) {
              document.title = document.title.split("QwenPaw").join("AgentX");
            }
          } catch (e) {}
        });
        titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
        agentxTitleWatcherInstalled = true;
        return 1;
      } catch (e) { return 0; }
    }
    function agentxBlockUpstreamLinks() {
      if (agentxLinkBlockerInstalled) return;
      try {
        document.addEventListener("click", function (ev) {
          try {
            var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
            if (!a) return;
            var href = a.getAttribute("href") || "";
            if (href.indexOf(AGENTX_UPSTREAM_DOC) === 0 || href.indexOf(AGENTX_UPSTREAM_GITHUB) === 0) {
              ev.preventDefault();
              ev.stopPropagation();
            }
          } catch (e) {}
        }, true);
        agentxLinkBlockerInstalled = true;
      } catch (e) {}
    }
    var AGENTX_RULES = [
      { id: "rename-title", run: function () {
        if (document.title && document.title.indexOf("QwenPaw") !== -1) document.title = document.title.split("QwenPaw").join("AgentX");
      } },
      { id: "rename-attrs", run: function () {
        var els;
        try { els = document.querySelectorAll('[aria-label*="QwenPaw"], [placeholder*="QwenPaw"], [title*="QwenPaw"]'); } catch (e) { return; }
        for (var i = 0; i < els.length; i++) {
          try {
            var el = els[i];
            var a = el.getAttribute("aria-label");
            if (a && a.indexOf("QwenPaw") !== -1) el.setAttribute("aria-label", a.split("QwenPaw").join("AgentX"));
            var p = el.getAttribute("placeholder");
            if (p && p.indexOf("QwenPaw") !== -1) el.setAttribute("placeholder", p.split("QwenPaw").join("AgentX"));
            var t = el.getAttribute("title");
            if (t && t.indexOf("QwenPaw") !== -1) el.setAttribute("title", t.split("QwenPaw").join("AgentX"));
          } catch (e) {}
        }
      } },
      { id: "rename-text", run: function () {
        try { agentxRenameTextIn(document.body); } catch (e) {}
      } },
      { id: "fix-grammar", run: function () {
        // Upstream console grammar (2026-11-18 QA): "Completed 1 steps"
        // and "1 providers online" — the count is 1 but the noun is
        // plural. Fix the singular forms in text nodes; other counts
        // ("2 steps", "3 providers") are already correct and untouched.
        // Regex with \s+ (not a literal space): the DOM inspection
        // showed the tree rendering "1providers online" with the space
        // dropped, so the separator may be a non-breaking space or
        // another whitespace character, and a literal "1 providers"
        // split never matches it (QA round 4).
        // Split-node case (QA round 2): React renders the count and the
        // label in SEPARATE text nodes ("1" | " providers online"), so
        // a single-node "1 providers" never matches. Collect the text
        // nodes in document order first, then fix a "providers" node
        // whose immediately preceding text node ends with "1".
        try {
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          var nodes = [];
          var node;
          while ((node = walker.nextNode())) nodes.push(node);
          for (var i = 0; i < nodes.length; i++) {
            try {
              var n = nodes[i];
              var t = n.nodeValue;
              if (!t) continue;
              var fixed = t.replace(/1\\s+steps/g, "1 step").replace(/1\\s+providers/g, "1 provider");
              if (fixed !== t) { n.nodeValue = fixed; continue; }
              if (t.indexOf("providers") !== -1 && i > 0) {
                // Split-node case: React may render the count and the
                // label in SEPARATE text nodes, but not necessarily
                // adjacent — there can be whitespace-only or empty text
                // nodes between them ("1" | " " | " providers online").
                // Walk backwards past whitespace-only nodes and fix the
                // "providers" node when the first non-whitespace node
                // before it ends with "1".
                var j = i - 1;
                var prevText = "";
                while (j >= 0) {
                  var cand = nodes[j] ? (nodes[j].nodeValue || "") : "";
                  if (/^\\s*$/.test(cand)) { j--; continue; }
                  prevText = cand;
                  break;
                }
                if (/\\b1\\s*$/.test(prevText)) {
                  n.nodeValue = t.split("providers").join("provider");
                }
              }
            } catch (e) {}
          }
        } catch (e) {}
      } },
      { id: "sidebar-ellipsis", run: function () {
        // Sidebar conversation titles (2026-11-18 QA + DOM inspection):
        // titles are cut mid-word with NO ellipsis ("Print Numbers 1 to
        // 20C", "Checking assistant avai"), and the "…" More actions
        // button sits on top of the last character. The rows are NOT
        // <a href="/chat/..."> — they are <button> elements (role
        // button, no href) in the left sidebar, each holding the title
        // text plus a small status <img> (alt "Idle") and a duplicate
        // title for the tooltip. The title is clipped at ~x200 by the
        // button's own overflow (not only by the More actions button,
        // which is a separate sibling that appears on hover). Give the
        // row buttons an ellipsis and right padding so the More actions
        // button has room and the cut reads as "…" instead of a clipped
        // word. The title text may live in a child span/div inside the
        // button (the a11y tree lists no wrapper, but React usually
        // wraps it), so the ellipsis goes on the button AND on any
        // text-bearing child.
        // SHADOW-DOM (2026-11-18 QA rounds 5–14): the rule never took
        // effect in 9 rounds even though the code is deployed and the
        // observer + timer both call it. The remaining explanation is
        // that the sidebar lives in a SHADOW ROOT (or an iframe-like
        // encapsulated subtree) that document.querySelectorAll cannot
        // see — other rules work because they target main-document
        // elements. So collect buttons by walking the whole tree and
        // descending into every shadowRoot.
        function collectButtons(root, out) {
          try {
            var list = root.querySelectorAll ? root.querySelectorAll("button,[role='button']") : [];
            for (var i = 0; i < list.length; i++) out.push(list[i]);
            var all = root.querySelectorAll ? root.querySelectorAll("*") : [];
            for (var j = 0; j < all.length; j++) {
              try {
                var sr = all[j].shadowRoot;
                if (sr) collectButtons(sr, out);
              } catch (e) {}
            }
          } catch (e) {}
          return out;
        }
        try {
          var btns = collectButtons(document, []);
          for (var i = 0; i < btns.length; i++) {
            try {
              var b = btns[i];
              // PROBE (2026-11-18 QA round 16 diagnostic, TEMPORARY):
              // 11 rounds, zero effect. Set a visible marker on EVERY
              // button this rule sees, before any selection gate, so the
              // QA can prove whether the rule runs at all. If ANY button
              // on the page gets a magenta outline, the rule executes;
              // if the sidebar rows specifically get it, the rule
              // reaches them and the truncation itself is the problem;
              // if nothing gets it, the rule never runs. Remove after
              // diagnosis.
              try { b.style.outline = "2px solid #ff00ff"; } catch (e) {}
              // NO early skip on data-agentx-ellipsis (2026-11-18 QA
              // rounds 5–12): React re-renders and RESETS the text
              // node to the full title, but the attribute survives (it
              // is not a React prop), so a skip meant the rule ran once
              // and never re-truncated after React reverted it. The
              // truncation below is idempotent (it skips text already
              // containing "…"), so re-running is safe. The wrapping is
              // guarded separately (see below).
              var name = "";
              try { name = (b.getAttribute("aria-label") || "") + " " + (b.textContent || ""); } catch (e) {}
              if (/more actions/i.test(name)) continue;
              if (/^\\s*(new task|new group|conversation history|by source|manage group)\\s*$/i.test((b.textContent || "").trim())) continue;
              var left = -1;
              try { left = b.getBoundingClientRect ? b.getBoundingClientRect().left : -1; } catch (e) {}
              var txt = (b.textContent || "").trim();
              if (txt.length < 3) continue;
              if (b.setAttribute) b.setAttribute("data-agentx-ellipsis", "1");
              b.style.overflow = "hidden";
              b.style.textOverflow = "ellipsis";
              b.style.whiteSpace = "nowrap";
              b.style.paddingRight = "30px";
              b.style.boxSizing = "border-box";
              b.style.maxWidth = "100%";
              // TRUNCATE FIRST, by length alone (2026-11-18 DOM
              // inspection: the row button is only ~179px wide, not
              // 228px — a 22-char title already overflows, so the old
              // 24-char threshold never fired for it, and the clipping
              // is at a parent container so no overflow measurement can
              // detect it). Cut the longest direct text node to 15
              // chars + "…" when it exceeds 16 chars. This runs before
              // any wrapping, so it cannot be skipped by it.
              // RECURSIVE (2026-11-18 QA round 14): the title may live
              // inside a child element (span/div) rather than as a
              // direct text node, so truncate EVERY text node in the
              // button's subtree, not only direct children.
              try {
                (function truncAll(node) {
                  try {
                    var ch = node.childNodes;
                    for (var q = 0; q < ch.length; q++) {
                      var cn = ch[q];
                      if (cn && cn.nodeType === 3) {
                        var vv = cn.nodeValue || "";
                        if (vv.length > 16 && vv.indexOf("…") === -1) {
                          cn.nodeValue = vv.slice(0, 15).replace(/\\s+$/, "") + "…";
                        }
                      } else if (cn && cn.nodeType === 1) {
                        truncAll(cn);
                      }
                    }
                  } catch (e) {}
                })(b);
              } catch (e) {}
              try {
                var direct = b.childNodes;
                for (var d = 0; d < direct.length; d++) {
                  var dt = direct[d];
                  if (dt && dt.nodeType === 3 && (dt.nodeValue || "").length > 16 && (dt.nodeValue || "").indexOf("…") === -1) {
                    dt.nodeValue = dt.nodeValue.slice(0, 15).replace(/\\s+$/, "") + "…";
                  }
                }
              } catch (e) {}
              var kids = b.querySelectorAll ? b.querySelectorAll("*") : [];
              for (var j = 0; j < kids.length; j++) {
                try {
                  var k = kids[j];
                  if (!k.textContent || !k.textContent.trim()) continue;
                  var tag = (k.tagName || "").toUpperCase();
                  if (tag === "IMG" || tag === "BUTTON" || tag === "INPUT" || tag === "SVG") continue;
                  k.style.overflow = "hidden";
                  k.style.textOverflow = "ellipsis";
                  k.style.whiteSpace = "nowrap";
                  k.style.maxWidth = "100%";
                  // Flex-item floor: in a flex row a text child will
                  // NOT shrink below its content size unless min-width
                  // is 0, so without this the title overflows (clipped
                  // mid-word, no ellipsis) instead of truncating.
                  k.style.minWidth = "0";
                  k.style.flexShrink = "1";
                  // Ellipsis only works on a block container. If the
                  // title lives in an inline element (span) inside a
                  // flex button, the inline box never truncates — make
                  // it a block so the ellipsis engages.
                  if (tag === "SPAN") k.style.display = "block";
                } catch (e) {}
              }
              // The title itself is often a bare TEXT NODE directly
              // inside the flex button (an anonymous flex item) — no
              // element to style, so no CSS ellipsis can engage on it.
              // Wrap the first substantial direct text node (the visible
              // title; the duplicate is a later node for the tooltip) in
              // a span that IS a real flex item and can truncate.
              // Guard: only wrap once — if a wrap span already exists
              // (from a previous run), do not wrap again, or nested
              // spans accumulate on every observer pass now that the
              // attribute skip is gone.
              try {
                var alreadyWrapped = false;
                try { alreadyWrapped = !!(b.querySelector && b.querySelector("span[data-agentx-title-wrap]")); } catch (e) {}
                if (!alreadyWrapped) {
                var nodes = b.childNodes;
                for (var n = 0; n < nodes.length; n++) {
                  var tn = nodes[n];
                  if (tn && tn.nodeType === 3 && tn.nodeValue && tn.nodeValue.trim().length >= 3) {
                    var span = document.createElement("span");
                    span.setAttribute("data-agentx-title-wrap", "1");
                    span.style.display = "block";
                    span.style.overflow = "hidden";
                    span.style.textOverflow = "ellipsis";
                    span.style.whiteSpace = "nowrap";
                    span.style.minWidth = "0";
                    span.style.flexShrink = "1";
                    span.style.maxWidth = "100%";
                    b.insertBefore(span, tn);
                    span.appendChild(tn);
                    break;
                  }
                }
                }
              } catch (e) {}
              try {
                // Truncate by LENGTH, not by measured overflow: the
                // clipping happens at a parent container (the button
                // itself reports no overflow — scrollWidth equals
                // clientWidth — so an overflow check never fires, which
                // is why rounds 5–10 never truncated). The sidebar is
                // ~228px wide and the title starts at ~x31, so ~170px
                // fits ~24 chars; anything longer is cut, so cut it in
                // the text with a real "…".
                var tNodes = b.childNodes;
                for (var m = 0; m < tNodes.length; m++) {
                  var t2 = tNodes[m];
                  if (t2 && t2.nodeType === 3) {
                    var val = t2.nodeValue || "";
                    if (val.trim().length >= 3 && val.length > 16 && val.indexOf("…") === -1) {
                      t2.nodeValue = val.slice(0, 15).replace(/\\s+$/, "") + "…";
                      break;
                    }
                  } else if (t2 && t2.textContent) {
                    var inner = t2.childNodes;
                    for (var q = 0; q < inner.length; q++) {
                      if (inner[q] && inner[q].nodeType === 3 && (inner[q].nodeValue || "").trim().length >= 3) {
                        var v = inner[q].nodeValue;
                        if (v.length > 16 && v.indexOf("…") === -1) {
                          inner[q].nodeValue = v.slice(0, 15).replace(/\\s+$/, "") + "…";
                        }
                        break;
                      }
                    }
                  }
                }
              } catch (e) {}
            } catch (e) {}
          }
        } catch (e) {}
      } },
      { id: "chat-input-fixes", run: function () {
        // Chat composer (2026-11-18 QA + DOM inspection).
        // (a) The blue "This tab queues only" banner has NO container
        // element — it is a bare text node + an info-circle img, both
        // direct children of <main>, directly above the input textbox,
        // with a 0–1 px rendered gap. There is no element to give a
        // margin-bottom to, so the gap goes on the INPUT box instead.
        // The textbox found by placeholder may be an inner <textarea>
        // inside a wrapper div, so the margin goes on the textbox AND
        // on its parent, so whichever renders the box gets the gap.
        // (b) The "Context usage" control is a <button> with NO child
        // elements — its text ("Context usage 10%, cache hit rate 81%")
        // lives only in its accessible name / description, and the only
        // visible content is a 16–18 px circular ring. It is not
        // clipped by an overflow-hidden parent; the text is simply not
        // rendered. Inject a small visible percentage label into the
        // button next to the ring, and let the button grow to fit it.
        try {
          var inputs = document.querySelectorAll("[placeholder]");
          for (var i = 0; i < inputs.length; i++) {
            try {
              var inp = inputs[i];
              var ph = "";
              try { ph = inp.getAttribute ? (inp.getAttribute("placeholder") || "") : ""; } catch (e) {}
              if (ph.indexOf("message navigation") === -1) continue;
              if (inp.getAttribute && inp.getAttribute("data-agentx-banner-gap")) continue;
              if (inp.setAttribute) inp.setAttribute("data-agentx-banner-gap", "1");
              inp.style.marginTop = "8px";
              var parent = inp.parentElement;
              if (parent && parent.tagName && /^(DIV|FORM)$/i.test(parent.tagName)) {
                parent.style.marginTop = "8px";
              }
            } catch (e) {}
          }
          var btns = document.querySelectorAll("button");
          for (var j = 0; j < btns.length; j++) {
            try {
              var b = btns[j];
              if (b.getAttribute && b.getAttribute("data-agentx-ctx-label")) continue;
              var label = "";
              try { label = (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "") + " " + (b.textContent || ""); } catch (e) {}
              if (label.indexOf("Context usage") === -1) continue;
              if (b.setAttribute) b.setAttribute("data-agentx-ctx-label", "1");
              var m = label.match(/Context usage\\s*(\\d+)\\s*%/);
              var pct = m ? m[1] + "%" : "";
              if (!pct) continue;
              var span = document.createElement("span");
              span.textContent = pct;
              span.style.cssText = "font-size:11px;line-height:1;color:#16a34a;font-weight:600;margin-left:4px;white-space:nowrap;flex:none;";
              b.appendChild(span);
              b.style.display = "inline-flex";
              b.style.alignItems = "center";
              b.style.minWidth = "0";
              b.style.width = "auto";
              b.style.maxWidth = "none";
              b.style.overflow = "visible";
            } catch (e) {}
          }
        } catch (e) {}
      } },
      { id: "page-bottom-padding", run: function () {
        // The three floating pills (Vault / Rest machine / Computer) are
        // fixed at the bottom-right and overlay whatever content sits
        // there — on the Models page they cover a provider card's
        // "Configure ›" link (QA round 7: only "Conf" visible on the
        // MiniMax card). Give <main> bottom padding so the last row of
        // content can always be scrolled fully above the pills. The
        // pills span bottom 16–152px, so 170px clears them.
        try {
          var main = document.querySelector ? document.querySelector("main") : null;
          if (main && !main.getAttribute("data-agentx-bottom-pad")) {
            main.setAttribute("data-agentx-bottom-pad", "1");
            main.style.paddingBottom = "170px";
            main.style.boxSizing = "border-box";
          }
        } catch (e) {}
      } },
      { id: "pill-positions", run: function () {
        // Re-apply the floating-pill positions on every mutation.
        // setOpen() sets them once when the Computer panel opens/closes,
        // but a re-render can reset the inline styles back to the
        // defaults (bottom 16/64/112) while the panel stays open — then
        // the pills sit on the composer's Send button (QA round 8).
        // This rule re-asserts the open/closed positions every time.
        try {
          var panel = document.getElementById("qwenpawComputerPanel");
          var cBtn = document.getElementById("qwenpawComputerBtn");
          var rBtn = document.getElementById("qwenpawRestBtn");
          var vBtn = document.getElementById("qwenpawVaultBtn");
          if (!panel || !cBtn || !rBtn || !vBtn) return;
          // The panel can be opened by the console's own UI (not only
          // by the floating pill's setOpen), which may show it via a
          // CSS class rather than an inline display style — so
          // panel.style.display is "" even while it is visible. Use
          // the COMPUTED display, which reflects the real state either
          // way. (2026-11-18 QA round 9: pills sat on Send because the
          // rule read the inline style and thought the panel was closed.)
          var disp = "";
          try { disp = window.getComputedStyle ? window.getComputedStyle(panel).display : ""; } catch (e) {}
          var isOpen = disp !== "none" && disp !== "";
          var right = isOpen ? "332px" : "16px";
          cBtn.style.right = right;
          rBtn.style.right = right;
          vBtn.style.right = right;
          // Hide the pills on Settings pages (2026-11-18 QA round 15):
          // they are fixed-position and persist across pages, where
          // they cover real Settings controls (e.g. the "Assistant
          // message collapse" segmented control on /settings/general)
          // and the open panel hides "1 provider online" on
          // /settings/models. The pills are a /chat convenience; on
          // Settings they only get in the way.
          var onSettings = false;
          try { onSettings = /\/settings(\/|$)/.test(window.location ? window.location.pathname : ""); } catch (e) {}
          if (onSettings) {
            cBtn.style.display = "none";
            rBtn.style.display = "none";
            vBtn.style.display = "none";
            return;
          }
          cBtn.style.display = "";
          rBtn.style.display = "";
          vBtn.style.display = "";
          cBtn.style.bottom = isOpen ? "380px" : "16px";
          rBtn.style.bottom = isOpen ? "428px" : "64px";
          vBtn.style.bottom = isOpen ? "476px" : "112px";
        } catch (e) {}
      } },
      { id: "rename-logo", run: function () {
        // Sidebar logo: an <img> with alt "QwenPaw" (browser verification
        // 2026-11-18: the sidebar still showed "QwenPaw" + "v2.3.0" on
        // every console page). An image cannot be renamed, so swap it for
        // the AgentX wordmark in text, in the same brand slot, so the
        // sidebar layout does not shift. The alt is renamed first, so the
        // a11y tree says AgentX even if the swap is skipped.
        // Size gate (2026-11-18 QA round 2): the bottom-left user card
        // ALSO carries a small QwenPaw avatar image, and swapping THAT
        // for an 18px "AgentX" span overflows its circle and prints over
        // the "satwik" / "Console account" text. Only the large brand
        // logo gets the text swap; a small avatar keeps its image (alt
        // renamed) so the user card stays readable. Gate on the
        // DISPLAYED width (getBoundingClientRect), not naturalWidth:
        // the logo file is intrinsically large, so naturalWidth passed
        // the avatar too — the avatar is DISPLAYED small (~32px) while
        // the brand logo is displayed large. An image whose displayed
        // size is not known yet (not laid out, width 0) is left alone —
        // it still matches the selector on a later pass, once laid out,
        // so the decision is made with a real size.
        var imgs;
        try { imgs = document.querySelectorAll('img[alt*="QwenPaw"]'); } catch (e) { return; }
        for (var i = 0; i < imgs.length; i++) {
          try {
            var img = imgs[i];
            if (img.getAttribute && img.getAttribute("data-agentx-logo")) continue;
            var w = 0;
            try { w = img.getBoundingClientRect ? img.getBoundingClientRect().width : 0; } catch (e) {}
            if (!w) { try { w = img.width || 0; } catch (e) {} }
            if (!w) continue;
            if (img.setAttribute) img.setAttribute("data-agentx-logo", "1");
            try { img.setAttribute("alt", (img.getAttribute("alt") || "").split("QwenPaw").join("AgentX")); } catch (e) {}
            if (w < 80) continue;
            try {
              var parent = img.parentNode;
              if (parent && document.createElement && parent.replaceChild) {
                var label = document.createElement("span");
                label.textContent = "AgentX";
                try { label.setAttribute("style", "font-weight:700;font-size:18px;line-height:1;"); } catch (e) {}
                parent.replaceChild(label, img);
              } else {
                img.style.display = "none";
              }
            } catch (e) { try { img.style.display = "none"; } catch (e2) {} }
          } catch (e) {}
        }
      } },
      { id: "hide-menu", run: function () {
        agentxHideByName(AGENTX_MENU_LABELS, "button, a, li, [role='menuitem'], [role='button'], [role='option'], span, div", "button, a, li, [role='menuitem'], [class*='menu-item']");
      } },
      { id: "hide-about", run: function () { agentxAboutRule(); } },
      { id: "hide-language", run: function () {
        var els;
        try { els = document.querySelectorAll('[aria-label*="Language"], [title*="Language"]'); } catch (e) { return; }
        for (var i = 0; i < els.length; i++) {
          try {
            var el = els[i];
            var target = el;
            try {
              var anc = el.closest ? el.closest("li, [role='menuitem'], button") : null;
              if (anc) target = anc;
            } catch (e) {}
            if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
            target.style.display = "none";
            if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          } catch (e) {}
        }
      } },
      { id: "hide-desktop-prompt", run: function () {
        agentxHideAncestorByContent("is ready to install", "[role='dialog'], [class*='modal'], [class*='banner'], [class*='alert'], [class*='notice']", "[role='dialog'], [class*='modal'], [class*='banner'], [class*='alert'], [class*='notice']");
      } },
      { id: "hide-codex-qoder", run: function () {
        agentxHideExact("QwenPaw, Codex and Qoder profiles", "li, button, a, [role='menuitem'], span, div, h1, h2, h3, h4", "li, [role='menuitem'], [class*='card'], [class*='row'], section, div");
        agentxHideExact("AgentX, Codex and Qoder profiles", "li, button, a, [role='menuitem'], span, div, h1, h2, h3, h4", "li, [role='menuitem'], [class*='card'], [class*='row'], section, div");
      } },
      { id: "hide-voice", run: function () {
        agentxHideAncestorByContent("qwenpaw[whisper]", "code, pre, kbd, span, div, p", "section, [class*='card'], [class*='setting'], [class*='panel']");
      } },
      { id: "hide-import-text", run: function () {
        agentxHideAncestorByContent("Import data from other AI applications", "span, div, p, li", "section, [class*='card'], [class*='row'], li, div");
      } },
      { id: "hide-china", run: function () {
        // agentxClimbToChinaCard, not the generic climb: the generic
        // climb hid the whole provider list (see agentxClimbToChinaCard).
        agentxHideByName(AGENTX_CHINA_LABELS, "li, button, a, [role='menuitem'], [role='listitem'], span, div, h1, h2, h3, h4, img", null, agentxClimbToChinaCard);
      } },
      { id: "block-links", run: function () { agentxBlockUpstreamLinks(); } },
    ];
    function agentxRunRules() {
      if (agentxRebrandOff()) return;
      var now = Date.now();
      if (now - agentxLastRun < 400) {
        if (!agentxTrailingTimer) {
          agentxTrailingTimer = setTimeout(function () {
            agentxTrailingTimer = null;
            agentxRunRules();
          }, 400);
        }
        return;
      }
      agentxLastRun = now;
      for (var i = 0; i < AGENTX_RULES.length; i++) {
        try { AGENTX_RULES[i].run(); } catch (e) { try { console.debug("[agentx] rule failed: " + AGENTX_RULES[i].id, e); } catch (e2) {} }
      }
    }
    /* AGENTX-REBRAND-END */
    // Run one rule by id, synchronously and unthrottled. The three
    // fragile fixes (grammar, sidebar ellipsis, chat input) fight React:
    // React re-renders and reverts the DOM mutation, and the 400 ms
    // throttle in agentxRunRules leaves a window where the unfixed text
    // shows (QA round 4: "1 providers online" still plural after 5 s).
    // Running them synchronously in the observer callback re-applies the
    // fix on every mutation, so React never wins the race for long.
    function agentxRunRuleNow(id) {
      try {
        for (var i = 0; i < AGENTX_RULES.length; i++) {
          if (AGENTX_RULES[i].id === id) { AGENTX_RULES[i].run(); return; }
        }
      } catch (e) {}
    }
    try {
      var vaultMenuObserver = new MutationObserver(function () {
        addVaultMenuItem();
        agentxRunRuleNow("fix-grammar");
        agentxRunRuleNow("sidebar-ellipsis");
        agentxRunRuleNow("chat-input-fixes");
        agentxRunRuleNow("page-bottom-padding");
        agentxRunRuleNow("pill-positions");
        agentxRunRules();
      });
      // characterData: React updates a text node in place (nodeValue)
      // when it re-renders — e.g. the Models page resetting "1 provider
      // online" back to "1 providers online". A childList-only observer
      // never fires for that, so the grammar fix was never re-applied
      // after the first React re-render (2026-11-18 DOM inspection).
      vaultMenuObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      // Timer re-apply (2026-11-18 QA rounds 5–13): the sidebar rule
      // still did not stick even after removing the done-marker skip —
      // React re-renders can revert the text node between observer
      // firings, and the observer may not fire for every React commit.
      // A 1.5 s timer re-runs the sidebar truncation independently, so
      // a reverted title is re-cut within ~1.5 s no matter what React
      // does. The truncation is idempotent (skips text already holding
      // "…"), so the timer is cheap and safe.
      // UI-TIMER-ALLOWLIST: sidebar-ellipsis re-apply timer. Client-side
      // only, runs only while the user has the console open, makes no
      // network calls and writes no data — it only re-truncates sidebar
      // title text nodes. Not a server poll loop.
      try {
        setInterval(function () { // UI-TIMER-ALLOWLIST: sidebar-ellipsis re-apply
          try { agentxRunRuleNow("sidebar-ellipsis"); } catch (e) {}
        }, 1500);
      } catch (e) {}
      addVaultMenuItem();
      agentxRunRules();
      agentxWatchTitle();
    } catch (e) { /* observer unavailable; the floating Vault button still works */ }
  } catch (e) { /* never break the console */ }
})();
</script>`;
}

function wakingPage(retryAfter) {
  // Live progress, not a blank wait (sleep/wake fix, 2026-11-17): the old
  // page was static text + a 30 s meta-refresh, so a cold wake looked like
  // a hung "Loading..." screen. This page shows an elapsed timer, a
  // progress bar, and a status line, and polls the console every 5 s —
  // reloading the moment the console answers instead of waiting for the
  // next 30 s refresh. The meta-refresh stays as a no-JS fallback.
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="refresh" content="60">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>AgentX — Waking up</title></head><body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaf0;padding:2rem;max-width:640px;margin:0 auto">` +
    `<h1>AgentX is waking up</h1>` +
    `<p id="status">The InstaBox machine was paused and is starting now.</p>` +
    `<div style="background:#1e2230;border-radius:8px;height:10px;overflow:hidden;margin:1rem 0"><div id="bar" style="background:#22c55e;height:100%;width:8%;border-radius:8px;transition:width 1s linear"></div></div>` +
    `<p style="color:#9aa4b2;font-size:13px">Elapsed: <span id="elapsed">0s</span>${retryAfter ? ` &middot; usually ready in about ${retryAfter} seconds` : ` &middot; usually ready in about a minute`}.</p>` +
    `<p><a style="color:#22c55e" href="/status">Status page</a></p>` +
    `<script>(function(){var t0=Date.now();var el=document.getElementById('elapsed');var bar=document.getElementById('bar');var st=document.getElementById('status');var tries=0;setInterval(function(){var s=Math.floor((Date.now()-t0)/1000);el.textContent=s+'s';bar.style.width=Math.min(8+s*1.2,96)+'%';},1000);async function poll(){tries++;try{var r=await fetch(location.pathname+location.search,{cache:'no-store',headers:{'Accept':'text/html'}});if(r.status===200){var t=await r.text();if(t.indexOf('<div id="root"')!==-1||t.indexOf('id="root"')!==-1){st.textContent='Machine is up — loading the console…';bar.style.width='100%';location.reload();return;}}st.textContent=tries<3?'The InstaBox machine was paused and is starting now.':'Still waking — the machine usually takes about a minute. Keeping watch…';}catch(e){/* network blip while waking; keep polling */}setTimeout(poll,5000);}setTimeout(poll,3000);})();</script>` +
    `</body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "30", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" } },
  );
}

/**
 * The cooldown page.
 *
 * `retryAfter` is seconds; `untilText` is the human wall-clock ("2026-11-16
 * 07:53 UTC") parsed from InstaBox's own message. Showing the time is the
 * difference between "wait" and "come back at 13:23" — the second is actionable,
 * and it is what Rohan asked for.
 */
function cooldownPage(retryAfter, untilText) {
  const mins = retryAfter ? Math.ceil(retryAfter / 60) : null;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    // Auto-refresh exactly when the cooldown is due to end, so the visitor does
    // not have to guess — and so we do not poll early (every early request is
    // refused and teaches the user the page is broken).
    (retryAfter ? `<meta http-equiv="refresh" content="${Math.max(5, mins ? mins * 60 : 60)}">` : ``) +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>AgentX — Cooldown</title></head><body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaf0;padding:2rem">` +
    `<h1>AgentX is in max-run cooldown</h1>` +
    `<p>The InstaBox Free machine hit its maximum run length and is cooling down. ` +
    `Nothing can wake it until the cooldown ends${mins ? ` — about ${mins} minutes` : ``}${
      untilText ? ` (<strong>${untilText}</strong>)` : ``
    }. This page refreshes itself when that time arrives.</p>` +
    `<p style="color:#9aa4b2;font-size:13px">The keep-alive Worker will also bring it back once the cooldown ends.</p>` +
    `<p><a style="color:#22c55e" href="/status">Status page</a></p>` +
    `</body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } },
  );
}

function parseRetryAfter(res, bodyText) {
  const h = res.headers.get("Retry-After");
  if (h && /^\d+$/.test(h.trim())) return Number(h.trim());
  try {
    const j = JSON.parse(bodyText || "{}");
    const s = j?.error?.retryAfterSeconds ?? j?.retryAfterSeconds;
    if (typeof s === "number") return s;
  } catch { /* not JSON */ }
  return null;
}

async function proxy(request, url, env, ctx) {
  // --- qwenpaw-query-token-leak mitigation (audit item, fixed 2026-11-15) ---
  // QwenPaw's console accepts the bearer token as `?token=` on EVERY request
  // (`app/auth.py::_extract_token` falls through to the query param; the SPA
  // itself emits `?token=` URLs for file previews). We cannot patch the
  // upstream container, and the SPA depends on the behaviour — so the fix
  // belongs here, at the only hop we control:
  //
  //   1. lift `?token=` into an `Authorization: Bearer` header, and
  //   2. DELETE it from the forwarded URL.
  //
  // The origin still authorizes (it checks the header FIRST), but the token
  // never reaches the InstaBox edge access log, and never appears in a
  // proxied redirect Location or an upstream error body.
  const fwdUrl = new URL(request.url);
  const queryToken = fwdUrl.searchParams.get("token");
  if (queryToken) {
    fwdUrl.searchParams.delete("token");
  }
  const originUrl = ORIGIN + fwdUrl.pathname + fwdUrl.search;
  const pagesOrigin = url.origin;
  const isSafeMethod = request.method === "GET" || request.method === "HEAD";

  const buildRequest = () => {
    const req = new Request(originUrl, request);
    req.headers.delete("host");
    req.headers.delete("cf-connecting-ip");
    req.headers.delete("cf-ipcountry");
    req.headers.delete("cf-ray");
    req.headers.delete("cf-visitor");
    req.headers.set("X-Forwarded-Host", url.host);
    req.headers.set("X-Forwarded-Proto", "https");
    // Apply the lifted token only when the caller did not already send a
    // bearer credential — an explicit header always wins.
    if (queryToken && !req.headers.get("Authorization")) {
      req.headers.set("Authorization", "Bearer " + queryToken);
    }
    return req;
  };

  let res;
  try {
    res = await fetch(buildRequest());
  } catch (err) {
    // Deliberately generic: fetch error text can contain the origin URL
    // or stack fragments — never reflect it to the visitor.
    return new Response("AgentX origin unreachable. Try again in a moment.", {
      status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  // 503 = InstaBox is waking the machine. Wait, then retry once (safe methods
  // only — a streamed request body cannot be sent twice). Still waking after
  // that: return the auto-refreshing waking page.
  if (res.status === 503 && isSafeMethod) {
    let retryAfter = null;
    try {
      const bodyText = await res.text();
      retryAfter = parseRetryAfter(res, bodyText);
    } catch { /* ignore */ }
    try {
      await sleep(WAKE_WAIT_MS);
      res = await fetch(buildRequest());
    } catch {
      return wakingPage(retryAfter);
    }
    if (res.status === 503) {
      try {
        const bodyText = await res.text();
        retryAfter = parseRetryAfter(res, bodyText) ?? retryAfter;
      } catch { /* ignore */ }
      return wakingPage(retryAfter);
    }
  } else if (res.status === 503) {
    return wakingPage(null);
  }

  // 409 = max-run cooldown (or another operation conflict). Surface it plainly.
  if (res.status === 409) {
    let retryAfter = null;
    let code = null;
    let untilText = null;
    try {
      const bodyText = await res.text();
      retryAfter = parseRetryAfter(res, bodyText);
      // InstaBox's own message carries the wall-clock instant:
      //   "machine is cooling down until 2026-11-16T07:53:20Z"
      // Quoting it back turns "wait" into "come back at 13:23", which is what
      // Rohan asked for and what a person can act on.
      const m = /until\s+([0-9T:.\-]+Z)/i.exec(bodyText || "");
      if (m) {
        const t = Date.parse(m[1]);
        if (Number.isFinite(t)) {
          untilText = new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
          // Trust the timestamp over the seconds field when both exist: the
          // seconds are relative to the response and drift if it is cached.
          const derived = Math.max(1, Math.round((t - Date.now()) / 1000));
          if (Number.isFinite(derived)) retryAfter = Math.min(retryAfter ?? derived, derived);
        }
      }
      code = JSON.parse(bodyText || "{}")?.error?.code ?? null;
    } catch { /* ignore */ }
    if (code === "machine_cooldown") return cooldownPage(retryAfter, untilText);
    return new Response(
      `AgentX is busy with another operation (409 ${code || ""}). Retry in a moment.`,
      { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  }

  const headers = rewriteHeaders(res, pagesOrigin);

  // WebSocket upgrade: return the upgrade response (with its webSocket) as-is.
  if (res.status === 101 && res.webSocket) {
    return new Response(null, { status: 101, headers, webSocket: res.webSocket });
  }

  // Side-panel injection (Rakazo's right bot sidebar, worker-injection
  // way): the QwenPaw console is a React SPA whose HTML the proxy serves.
  // Its CSP is only `frame-ancestors 'self'` — no script-src — so an
  // injected same-origin <script> runs. The script appends a floating
  // "Computer" button + a 316px right sidebar panel (iframe to /desktop)
  // to document.body, OUTSIDE React's #root, so React re-renders can
  // never remove it. Only the SPA index is injected (marker
  // `<div id="root"`); API JSON, SSE streams and assets are untouched.
  // The injection is defensive (try/catch, feature-detect) so a failure
  // can never break the console.
  //
  // AgentX rebrand (2026-11-18): the same injection carries the early shim
  // (headShim — fetch/window.open patches, must run before the deferred
  // module bundle) and the rebrand rules (inside computerPanelScript).
  // The <title> is rewritten here at the proxy layer because the root HTML
  // is ours to serve; the observer renames it again if React changes it.
  // Kill switch: AGENTX_REBRAND=0 (worker env) skips the shim and bakes
  // the rebrand flag false; ?rebrand=0 skips it per page load at runtime.
  if (isSafeMethod && res.status === 200 && (headers.get("Content-Type") || "").includes("text/html")) {
    try {
      const html = await res.text();
      if (html.includes('<div id="root"') && html.includes("</body>")) {
        // A console page load is a visit (sleep/wake signal). Fire-and-forget.
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(recordLastVisit(env));
        const rebrandEnabled = env.AGENTX_REBRAND !== "0";
        const titled = html.replace("<title>QwenPaw Console</title>", "<title>AgentX Console</title>");
        // Search settings UI (2026-11-18): the Settings "Search" section
        // (TinyFish key + feature checkboxes) loads as a module from the
        // Pages assets and self-mounts when the Settings page is present.
        // A module script is deferred, so it runs after the SPA HTML parses.
        const searchSettingsScript = '<script type="module" src="/search-settings-ui.js"></script>';
        const injected = titled.replace("</body>", (rebrandEnabled ? headShim() : "") + computerPanelScript(rebrandEnabled) + searchSettingsScript + "</body>");
        headers.set("Cache-Control", "no-store, no-transform");
        headers.delete("ETag");
        headers.delete("Last-Modified");
        headers.delete("Content-Length");
        // AgentX rebrand (2026-11-18): block the Alibaba CDN illustration
        // images (gw.alicdn.com / img.alicdn.com, 17 distinct URLs on
        // channel/setup pages) at the header layer. Report-Only first —
        // nothing is blocked yet, violations are logged to the console;
        // promote to an enforcing img-src after a day of reports. No
        // report-uri is set (no endpoint exists yet); check DevTools.
        // Referrer-Policy no-referrer overrides the same-origin set by
        // rewriteHeaders for this HTML response only: strictly better for
        // the token-leak fix (nothing is sent anywhere) and it does not
        // break same-origin navigation, which does not need a Referer.
        headers.set("Content-Security-Policy-Report-Only", "img-src 'self' data: blob:");
        headers.set("Referrer-Policy", "no-referrer");
        return new Response(injected, { status: res.status, statusText: res.statusText, headers });
      }
      return new Response(html, { status: res.status, statusText: res.statusText, headers });
    } catch {
      // The origin body could not be read (it may now be consumed) —
      // do not return a broken stream.
      return new Response("AgentX console temporarily unavailable. Try again in a moment.", {
        status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
  }

  // Hashed-asset caching (sleep/wake + slow-open fix, 2026-11-17): the
  // console SPA is a 1 MB JS bundle whose filename carries a content hash
  // (e.g. /assets/index-DZrIuh3B.js). It is re-downloaded fresh on EVERY
  // load today because the proxy (and/or the origin) marks it no-store —
  // a big part of the slow open. A content-hashed filename can never go
  // stale (a rebuild produces a NEW filename, and the HTML references the
  // new one), so it is safe to cache for a year. HTML and API responses
  // keep no-store. The hash test is deliberately strict: a bare
  // /assets/foo.js (no hash) stays no-store.
  if (/^\/assets\/[^/]*-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(url.pathname)) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.delete("ETag");
    headers.delete("Last-Modified");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Status / wake page — served from static assets, not proxied.
    if (path === "/status" || path === "/status.html") {
      if (!env.ASSETS) {
        return new Response("Status page assets are not bound.", { status: 500 });
      }
      // NOTE: fetch "status-page.html", not "status.html" — Pages redirects
      // a request for /status.html to the clean URL /status (308), which
      // would loop back here. The differently-named asset is served as-is.
      return env.ASSETS.fetch(new Request(url.origin + "/status-page.html"));
    }

    // Search settings UI — the Settings "Search" section (TinyFish key +
    // feature checkboxes, 2026-11-18). The module is a Pages static asset
    // (pages/public/search-settings-ui.js); without this route the request
    // falls through to the console proxy, which answers with the SPA HTML
    // (B-35) and the <script src> parses as nothing.
    if (path === "/search-settings-ui.js") {
      if (!env.ASSETS) {
        return new Response("Search settings assets are not bound.", { status: 500 });
      }
      return env.ASSETS.fetch(new Request(url.origin + "/search-settings-ui.js"));
    }

    // Computer (rebuilt from Rakazo's design, 2026-11-15). Everything under
    // /computer is its own surface; the console proxy below is untouched.
    // `/vendor/*` is routed to the computer surface too. The UI loads xterm
    // from `/vendor/xterm.js`, and without this the request fell through to the
    // CONSOLE PROXY — which answered it with the QwenPaw SPA: 200, text/html,
    // 45,989 bytes. A `<script src>` served as HTML parses as nothing, so
    // `window.Terminal` was never defined and the terminal pane stayed black
    // while the session still showed "connected" (BUGS.md B-35).
    //
    // A 200 with the wrong body type is the worst failure shape there is: no
    // onerror, no console message, nothing to grep. Serving it from the Pages
    // asset binding with the right MIME is the fix.
    if (path === "/computer" || path.startsWith("/computer/") || path.startsWith("/vendor/")) {
      try {
        return await handleComputer(request, env, url);
      } catch (err) {
        return new Response(JSON.stringify({ error: "computer_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Vault (Rakazo-style API-key vault, 2026-11-17). Everything under /vault
    // is its own surface; the console proxy below is untouched. The page
    // itself is exempt from the session gate (B-39 lesson — the page is
    // static bytes, the way in); every endpoint it calls is gated by the
    // vault router's own requiresSession(). ORIGIN is passed through so
    // /vault/reveal can verify the console bearer token against
    // /api/cron/jobs (the same probe /api/session/mint uses).
    if (path === "/vault" || path.startsWith("/vault/")) {
      try {
        return await handleVault(request, env, url, ORIGIN);
      } catch (err) {
        return new Response(JSON.stringify({ error: "vault_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Settings Reset (2026-11-18). Everything under /reset is its own
    // surface; the page itself is exempt from the session gate (B-39 lesson),
    // every API call is verified live against the console by the reset
    // router's authenticate() and forwarded to the machine-side reset
    // broker. See features/reset/README.md.
    if (path === "/reset" || path.startsWith("/reset/")) {
      try {
        return await handleReset(request, env, url, ORIGIN);
      } catch (err) {
        return new Response(JSON.stringify({ error: "reset_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ---- session for the /computer surface (see pages/public/session.js) ----
    //
    // This is the ONLY place a DESKTOP_SESSION cookie is minted. It requires a
    // bearer token the console actually accepts, so the cookie inherits the
    // console's own revocation behaviour: revoke the token upstream and the
    // next mint fails. The cookie carries no console credential — it is only
    // proof that this browser passed that check within the TTL.
    //
    // POST only: a GET would be mintable by any <img src>, which turns every
    // page that can embed a URL into a session factory.
    if (path === "/api/session/mint") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const auth = await authenticate(request, env, ORIGIN);
      if (!auth.ok) {
        return new Response(JSON.stringify({
          error: auth.error,
          detail: auth.detail || null,
        }), {
          status: auth.status || 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const secret = env.COMPUTER_SESSION_SECRET || env.COMPUTER_CAPABILITY_SECRET;
      const value = await mintSession(secret, { ttlMs: SESSION_TTL_MS });
      if (!value) {
        // Fail closed and NAME the missing secret. Minting an unsigned or
        // default-keyed session would be worse than minting none.
        return new Response(JSON.stringify({
          error: "unconfigured",
          detail: "COMPUTER_SESSION_SECRET (or COMPUTER_CAPABILITY_SECRET) is not set, "
            + "so no session can be minted.",
        }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return new Response(JSON.stringify({ ok: true, expiresInMs: SESSION_TTL_MS }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": sessionSetCookie(value),
        },
      });
    }

    // Honest status read: the /computer page asks this on load so it can tell
    // "you are not signed in" apart from "the store is broken". No cookie is
    // returned by this endpoint, so it is safe to answer anonymously.
    if (path === "/api/session/state") {
      const s = await sessionFromRequest(env, request);
      return new Response(JSON.stringify({ ok: s.ok, reason: s.ok ? null : s.reason }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Clearing is a POST for the same reason minting is: a logout reachable by
    // GET is a logout a third-party <img> can trigger.
    if (path === "/api/session/clear") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": sessionClearCookie(),
        },
      });
    }

    // ---- machine rest / state (Rohan's manual-rest feature) ----
    // The Rest button lives in the console header (injected below) so it is
    // always reachable; these are the endpoints behind it.
    if (path === "/api/machine/rest") {
      try {
        return await restMachine(request, env, ORIGIN);
      } catch (err) {
        return new Response(JSON.stringify({ error: "machine_rest_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }
    // Intelligent sleep/wake (2026-11-17): the keep-alive Worker calls this
    // when its decision function says SLEEP. Auth is the shared SLEEP_TOKEN
    // (machine-control.js), not a console session — the keep-alive Worker
    // has no console session. Pages holds INSTABOX_API_KEY and suspends.
    if (path === "/api/machine/sleep") {
      try {
        return await sleepMachine(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: "machine_sleep_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }
    if (path === "/api/machine/state") {
      try {
        return await machineState(env);
      } catch (err) {
        return new Response(JSON.stringify({ error: "machine_state_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    return proxy(request, url, env, ctx);
  },
};

// --- Intelligent sleep/wake: last-visit recording (2026-11-17) ----------
// A console page load is a visit: the user is here, so the keep-alive
// must keep the machine awake. Recorded in D1 meta (sleepwake:last-visit),
// throttled to one write per 5 minutes so a page reload storm cannot
// burn the D1 write budget. Fire-and-forget via ctx.waitUntil so the
// write never delays the console. Never throws (a failed write must not
// break the page). Only page loads count — /api/* polling is excluded
// (the SPA polls constantly; counting it would keep the machine awake
// forever). The call site is the HTML-injection branch in proxy(), which
// only fires for the SPA index.
async function recordLastVisit(env) {
  const db = env.COMPUTER_DB || env.QWENPAW_DB;
  if (!db) return;
  try {
    const now = Date.now();
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind("sleepwake:last-visit").first();
    const prev = row && row.value ? Number(row.value) : NaN;
    if (Number.isFinite(prev) && now - prev < 5 * 60_000) return;
    await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind("sleepwake:last-visit", String(now)).run();
  } catch { /* never break the console */ }
}
