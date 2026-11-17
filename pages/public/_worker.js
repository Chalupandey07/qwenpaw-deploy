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
import { restMachine, sleepMachine, machineState, authenticate } from "./machine-control.js";
import {
  mintSession, sessionFromRequest, sessionSetCookie, sessionClearCookie, SESSION_TTL_MS,
} from "./session.js";

const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const WAKE_WAIT_MS = 45_000;
const KEEPALIVE_URL = "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev";
const MACHINE_ID = "m_" + new URL(ORIGIN).hostname.split(".")[0].split("-").slice(1).join("-");

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
function computerPanelScript() {
  return `<script>
(function () {
  try {
    if (!document.getElementById("root")) return;
    if (document.getElementById("qwenpawComputerBtn")) return;
    var btn = document.createElement("button");
    btn.id = "qwenpawComputerBtn";
    btn.type = "button";
    btn.textContent = "Computer";
    btn.title = "QwenPaw's computer — watch and drive the live desktop";
    btn.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 16px;border-radius:999px;border:1px solid #343945;background:#171a21;color:#e8eaf0;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45);";

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
    restBtn.style.cssText = "position:fixed;right:16px;bottom:64px;z-index:2147483647;padding:10px 16px;border-radius:999px;border:1px solid #34404f;background:#171a21;color:#c8d1dc;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45);";

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
    vaultBtn.style.cssText = "position:fixed;right:16px;bottom:112px;z-index:2147483647;padding:10px 16px;border-radius:999px;border:1px solid #343945;background:#171a21;color:#e8eaf0;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45);";

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
      openVaultPopup();
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
    try {
      var vaultMenuObserver = new MutationObserver(function () { addVaultMenuItem(); });
      vaultMenuObserver.observe(document.body, { childList: true, subtree: true });
      addVaultMenuItem();
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
    `<title>QwenPaw — Waking up</title></head><body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaf0;padding:2rem;max-width:640px;margin:0 auto">` +
    `<h1>QwenPaw is waking up</h1>` +
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
    `<title>QwenPaw — Cooldown</title></head><body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaf0;padding:2rem">` +
    `<h1>QwenPaw is in max-run cooldown</h1>` +
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
    return new Response("QwenPaw origin unreachable. Try again in a moment.", {
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
      `QwenPaw is busy with another operation (409 ${code || ""}). Retry in a moment.`,
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
  if (isSafeMethod && res.status === 200 && (headers.get("Content-Type") || "").includes("text/html")) {
    try {
      const html = await res.text();
      if (html.includes('<div id="root"') && html.includes("</body>")) {
        // A console page load is a visit (sleep/wake signal). Fire-and-forget.
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(recordLastVisit(env));
        const injected = html.replace("</body>", computerPanelScript() + "</body>");
        headers.set("Cache-Control", "no-store, no-transform");
        headers.delete("ETag");
        headers.delete("Last-Modified");
        headers.delete("Content-Length");
        return new Response(injected, { status: res.status, statusText: res.statusText, headers });
      }
      return new Response(html, { status: res.status, statusText: res.statusText, headers });
    } catch {
      // The origin body could not be read (it may now be consumed) —
      // do not return a broken stream.
      return new Response("QwenPaw console temporarily unavailable. Try again in a moment.", {
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
