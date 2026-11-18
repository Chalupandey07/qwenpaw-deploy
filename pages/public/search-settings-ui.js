// Search section for the console Settings page (TinyFish).
//
// Injected into the Settings page by the Pages worker (see _worker.js,
// the same MutationObserver that carries the rebrand rules). It gives
// the user one place to add the TinyFish API key and pick the search
// features, instead of typing raw env var names.
//
// Storage is QwenPaw's own env vars (working.secret/envs.json), through
// the console backend's env endpoint — the same path the console's own
// Environments page uses, so no new broker and no new Pages route are
// needed:
//   GET    /api/envs            load (presence of the key + flag values)
//   PATCH  /api/envs            save (merge — only the vars it sends)
//   DELETE /api/envs/<key>      remove the key
// Never PUT (it would replace ALL environment variables).
//
// The key value is NEVER rendered into the DOM (except the password
// input the user types into, which is masked and cleared after save),
// never logged, and never appears in a GET. It appears only in the
// PATCH request body, which is the save itself.
//
// This module is framework-free (plain DOM APIs) so it runs in the
// browser and in the Node harness (test_search_settings_ui.mjs) with a
// minimal DOM mock. It does not import anything.

export const KEY_ENV = "TINYFISH_API_KEY";
export const DREX_KEY_ENV = "NACE_API_KEY";
export const FLAG_SEARCH_ENV = "TINYFISH_SEARCH";
export const FLAG_FETCH_ENV = "TINYFISH_FETCH";
export const FLAG_DDG_ENV = "TINYFISH_DDG_IA";
export const FEATURE_ENVS = [FLAG_SEARCH_ENV, FLAG_FETCH_ENV, FLAG_DDG_ENV];
export const ENVS_API = "/api/envs";
export const SECTION_ID = "qwenpawYourKeys";

/** A flag env value: off only for "0"/"false"/"no"/"off" (any case). */
export function flagOn(value) {
  if (value === undefined || value === null) return true;
  const v = String(value).trim().toLowerCase();
  if (v === "") return true;
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/**
 * Parse a GET /api/envs response (a list of {key, value}) into the
 * form state. Returns {hasKey, hasDrexKey, search, fetch, ddg} —
 * booleans only. The key VALUES are never returned, so no caller can
 * render or log them.
 */
export function parseLoadResponse(envList) {
  const byKey = {};
  for (const item of envList || []) {
    if (item && typeof item.key === "string") byKey[item.key] = item.value;
  }
  const keyVal = byKey[KEY_ENV];
  const drexVal = byKey[DREX_KEY_ENV];
  return {
    hasKey: typeof keyVal === "string" && keyVal.trim() !== "",
    hasDrexKey: typeof drexVal === "string" && drexVal.trim() !== "",
    search: flagOn(byKey[FLAG_SEARCH_ENV]),
    fetch: flagOn(byKey[FLAG_FETCH_ENV]),
    ddg: flagOn(byKey[FLAG_DDG_ENV]),
  };
}

/**
 * Build the PATCH /api/envs body from the form state.
 * state = {keyTyped, drexKeyTyped, search, fetch, ddg}. A key is
 * included ONLY when the user typed a non-empty value (an empty field
 * means "leave the saved key alone", never "wipe it"). Flags are
 * always sent as "1"/"0".
 */
export function buildSaveBody(state) {
  const body = {};
  const typed = (state.keyTyped || "").trim();
  if (typed !== "") body[KEY_ENV] = typed;
  const drexTyped = (state.drexKeyTyped || "").trim();
  if (drexTyped !== "") body[DREX_KEY_ENV] = drexTyped;
  body[FLAG_SEARCH_ENV] = state.search ? "1" : "0";
  body[FLAG_FETCH_ENV] = state.fetch ? "1" : "0";
  body[FLAG_DDG_ENV] = state.ddg ? "1" : "0";
  return body;
}

/** True when the document is the console Settings page. */
function isSettingsPage(doc) {
  // The console is a React SPA; the Settings view may render under a
  // /settings path or behind a "Settings" heading. The chat page has
  // neither, so this gates the main-element fallback (below) off it.
  let path = "";
  try {
    const loc = (doc && doc.defaultView && doc.defaultView.location)
      || (typeof location !== "undefined" ? location : null);
    path = (loc && loc.pathname) || "";
  } catch (_e) { path = ""; }
  if (String(path).toLowerCase().includes("settings")) return true;
  if (doc.querySelectorAll) {
    for (const h of doc.querySelectorAll("h1,h2,h3,h4,[role='heading']")) {
      if ((h.textContent || "").trim().toLowerCase() === "settings") {
        return true;
      }
    }
  }
  return false;
}

/** Climb from a heading to its section/card container, or null. */
function climbToSection(el) {
  let cur = el;
  for (let i = 0; i < 6 && cur.parentElement; i++) {
    cur = cur.parentElement;
    const cls = (cur.className || "").toString().toLowerCase();
    if (cls.includes("section") || cls.includes("card")
      || cls.includes("panel") || cur.tagName === "SECTION") {
      return cur;
    }
  }
  return null;
}

/** True when the element sits inside the page navigation (left nav / sidebar). */
function isInNav(el) {
  let cur = el;
  while (cur && cur.parentElement) {
    cur = cur.parentElement;
    const tag = (cur.tagName || "").toUpperCase();
    if (tag === "NAV" || tag === "ASIDE") return true;
    const cls = (cur.className || "").toString().toLowerCase();
    if (cls.includes("sidebar") || cls.includes("left-nav")
      || cls.includes("nav-") || cls.includes("sidenav")) return true;
  }
  return false;
}

/**
 * Find the settings CONTENT COLUMN to append the "Your Keys" section
 * into, or null. The column is the parent of the settings cards — it
 * carries the page's left indent (sidebar + card offset). Appending
 * there keeps the section aligned with the cards instead of flush
 * against the viewport edge (2026-11-18 QA: the old code inserted
 * after the Environments container, or appended to full-width <main>
 * when no Environments heading was on the page, and the section
 * landed at x=0-2px on every Settings page).
 *
 * Settings-page ONLY (2026-11-18 QA round 2, N1): the heading search
 * must not run on the chat page at all — the chat view has headings
 * too, and the section mounted at the top of a conversation, hiding
 * messages. Nav headings are skipped as well (round 2: the first
 * heading found was in the left nav, so the section landed inside the
 * 265px nav column at x=17 instead of the content column at x=330).
 */
function findAnchor(doc) {
  if (!isSettingsPage(doc)) return null;
  const headings = doc.querySelectorAll
    ? doc.querySelectorAll("h1,h2,h3,h4,[role='heading']")
    : [];
  // Prefer the Environments card (the key lives there too); any other
  // settings heading gives the same content column.
  let envColumn = null;
  let anyColumn = null;
  for (const h of headings) {
    if (isInNav(h)) continue;
    const text = (h.textContent || "").trim().toLowerCase();
    const container = climbToSection(h);
    if (!container || !container.parentElement) continue;
    const column = container.parentElement;
    if (text.includes("environment")) {
      envColumn = column;
      break;
    }
    if (!anyColumn) anyColumn = column;
  }
  if (envColumn) return envColumn;
  if (anyColumn) return anyColumn;
  // Last resort, Settings page only: the main element. (On the chat
  // page there is a <main> too — never mount there; the guard above
  // already returned null there.)
  if (doc.querySelector) {
    const main = doc.querySelector("main,[role='main']");
    if (main) return main;
  }
  return null;
}

function el(doc, tag, attrs, text) {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") node.className = v;
      else node.setAttribute(k, v);
    }
  }
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

const STYLE_ID = "qwenpaw-search-settings-style";

/**
 * Inject the section's styles once. The console's own stylesheet does
 * not know these classes, so without this the section renders as bare
 * unstyled HTML: a narrow key input, and each checkbox label jammed
 * against its hint with no gap (2026-11-18 screenshot). Scoped to the
 * section id so it cannot leak into the console's own UI.
 */
function ensureStyles(doc) {
  if (!doc || !doc.createElement || !doc.head) return;
  if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.setAttribute("id", STYLE_ID);
  style.textContent = [
    "#qwenpawYourKeys{margin:24px 0;padding:16px 0 8px;"
      + "border-top:1px solid rgba(128,128,128,.35);max-width:720px;"
      + "width:100%;box-sizing:border-box;}",
    "#qwenpawYourKeys h2{margin:0 0 8px;}",
    "#qwenpawYourKeys h3{margin:16px 0 8px;}",
    "#qwenpawYourKeys p{margin:0 0 12px;}",
    ".qwenpaw-key-block{margin:0 0 16px;}",
    // Label on its own line, description below it (muted). The old
    // one-line flex row ran the two together with no break
    // ("TinyFish (Monid) API key Free live web search…", 2026-11-18 QA).
    ".qwenpaw-key-head{display:flex;flex-direction:column;"
      + "align-items:flex-start;gap:2px;margin:0 0 6px;}",
    ".qwenpaw-key-head label{font-weight:600;}",
    ".qwenpaw-key-head span{opacity:.75;font-size:13px;}",
    ".qwenpaw-search-row{display:flex;align-items:center;gap:10px;"
      + "margin:0 0 10px;flex-wrap:wrap;}",
    ".qwenpaw-search-row label{font-weight:600;white-space:nowrap;}",
    "#qwenpaw-tinyfish-key,#qwenpaw-drex-key{flex:1 1 220px;min-width:180px;"
      + "padding:8px 10px;}",
    "#qwenpaw-tinyfish-key-state,#qwenpaw-drex-key-state{opacity:.75;"
      + "white-space:nowrap;}",
    ".qwenpaw-search-row input[type='checkbox']{flex:0 0 auto;}",
    ".qwenpaw-search-row span{opacity:.75;}",
    "#qwenpawYourKeys button{padding:8px 14px;cursor:pointer;}",
    "#qwenpaw-search-status{opacity:.75;}",
  ].join("\n");
  doc.head.appendChild(style);
}

/**
 * Inject the Search section into the Settings page. doc is the document,
 * fetchImpl is fetch (injectable for the harness). Returns the section
 * element, or null when the Settings page is not present or the section
 * is already mounted. Never throws: any failure is a silent no-op so a
 * broken Search section can never break Settings.
 */
export function mountSearchSettings(doc, fetchImpl) {
  try {
    if (!doc || !doc.createElement) return null;
    if (doc.getElementById && doc.getElementById(SECTION_ID)) return null;
    const anchor = findAnchor(doc);
    if (!anchor) return null;
    const fetchFn = fetchImpl
      || (typeof fetch !== "undefined" ? fetch : null);
    if (!fetchFn) return null;

    ensureStyles(doc);

    const section = el(doc, "section", {
      id: SECTION_ID,
      "data-qwenpaw-search-settings": "true",
    });
    section.appendChild(el(doc, "h2", null, "Your Keys"));
    section.appendChild(el(doc, "p", null,
      "Add your API keys once. Each key is stored encrypted and is never "
      + "shown again after you save it."));

    // One key block per key: label + what it is for, then the password
    // input + saved indicator (never the value) + its own Remove button.
    // Returns {input, state, removeBtn}.
    const keyBlock = (inputId, labelText, whatFor, placeholder) => {
      const block = el(doc, "div", { className: "qwenpaw-key-block" });
      const head = el(doc, "div", { className: "qwenpaw-key-head" });
      head.appendChild(el(doc, "label", { for: inputId }, labelText));
      head.appendChild(el(doc, "span", null, whatFor));
      block.appendChild(head);
      const row = el(doc, "div", { className: "qwenpaw-search-row" });
      const input = el(doc, "input", {
        id: inputId,
        type: "password",
        autocomplete: "new-password",
        placeholder,
      });
      row.appendChild(input);
      const state = el(doc, "span", {
        id: `${inputId}-state`,
      }, "No key saved.");
      row.appendChild(state);
      const removeBtn = el(doc, "button", { type: "button" }, "Remove");
      row.appendChild(removeBtn);
      block.appendChild(row);
      section.appendChild(block);
      return { input, state, removeBtn };
    };

    const tinyfish = keyBlock(
      "qwenpaw-tinyfish-key",
      "TinyFish (Monid) API key",
      "Free live web search + page fetch. Get your key at app.monid.ai.",
      "Paste your Monid API key (from app.monid.ai)",
    );
    const drex = keyBlock(
      "qwenpaw-drex-key",
      "Drex (NACE) API key",
      "Decision model for verdicts and triage. Get your key from NACE (console.nace.ai).",
      "Paste your NACE API key (from console.nace.ai)",
    );

    // Search feature checkboxes.
    section.appendChild(el(doc, "h3", null, "Search features"));
    const checks = [];
    const features = [
      [FLAG_SEARCH_ENV, "tinyfish-search", "TinyFish search",
       "Search the live web with TinyFish (ranked results)."],
      [FLAG_FETCH_ENV, "tinyfish-fetch", "TinyFish fetch",
       "Fetch pages as clean Markdown (renders JavaScript)."],
      [FLAG_DDG_ENV, "tinyfish-ddg", "DuckDuckGo Instant Answer",
       "Quick abstract for factual questions (keyless complement)."],
    ];
    for (const [envName, id, label, hint] of features) {
      const row = el(doc, "div", { className: "qwenpaw-search-row" });
      const box = el(doc, "input", { id: `qwenpaw-${id}`, type: "checkbox" });
      box.checked = true;
      box.dataset.env = envName;
      row.appendChild(box);
      row.appendChild(el(doc, "label", { for: `qwenpaw-${id}` }, label));
      row.appendChild(el(doc, "span", null, hint));
      section.appendChild(row);
      checks.push(box);
    }
    section.appendChild(el(doc, "p", null,
      "The built-in search is always the fallback and cannot be turned off."));

    // Save button + status.
    const saveBtn = el(doc, "button", { type: "button" }, "Save");
    const status = el(doc, "span", { id: "qwenpaw-search-status" }, "");
    const btnRow = el(doc, "div", { className: "qwenpaw-search-row" });
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(status);
    section.appendChild(btnRow);

    const setStatus = (msg) => { status.textContent = msg; };

    // Remove one key: DELETE /api/envs/<KEY>. Shared by both keys.
    const removeKey = (envName, stateEl, labelText) => {
      if (typeof confirm === "function"
        && !confirm(`Remove the saved ${labelText} key?`)) return;
      fetchFn(ENVS_API + "/" + envName, {
        method: "DELETE",
        credentials: "same-origin",
      })
        .then((res) => {
          if (!res.ok) throw new Error("remove failed: " + res.status);
          stateEl.textContent = "No key saved.";
          setStatus("Key removed.");
        })
        .catch(() => setStatus("Remove failed. Try again."));
    };
    tinyfish.removeBtn.addEventListener("click", () =>
      removeKey(KEY_ENV, tinyfish.state, "TinyFish (Monid)"));
    drex.removeBtn.addEventListener("click", () =>
      removeKey(DREX_KEY_ENV, drex.state, "Drex (NACE)"));

    // Load current state (presence of each key + flag values only).
    fetchFn(ENVS_API, { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        const state = parseLoadResponse(list);
        tinyfish.state.textContent = state.hasKey
          ? "Key saved." : "No key saved.";
        drex.state.textContent = state.hasDrexKey
          ? "Key saved." : "No key saved.";
        checks[0].checked = state.search;
        checks[1].checked = state.fetch;
        checks[2].checked = state.ddg;
      })
      .catch(() => setStatus("Could not load search settings."));

    saveBtn.addEventListener("click", () => {
      const body = buildSaveBody({
        keyTyped: tinyfish.input.value,
        drexKeyTyped: drex.input.value,
        search: checks[0].checked,
        fetch: checks[1].checked,
        ddg: checks[2].checked,
      });
      fetchFn(ENVS_API, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((res) => {
          if (!res.ok) throw new Error("save failed: " + res.status);
          // Clear the typed keys so they never sit in the inputs.
          tinyfish.input.value = "";
          drex.input.value = "";
          if (body[KEY_ENV]) {
            tinyfish.state.textContent = "Key saved.";
          }
          if (body[DREX_KEY_ENV]) {
            drex.state.textContent = "Key saved.";
          }
          setStatus("Saved.");
        })
        .catch(() => setStatus("Save failed. Try again."));
    });

    // Append at the end of the content column (after all settings
    // cards), inheriting the column's indent and width. The anchor IS
    // the column (findAnchor returns the cards' parent), so appendChild
    // is the whole insertion — never insertBefore a card, which would
    // put the section outside the column.
    anchor.appendChild(section);
    return section;
  } catch (_e) {
    return null;
  }
}

// Self-mount (browser only — skipped when imported by the Node harness,
// where `document` is undefined). The console is a React SPA: the user
// may load any page first and navigate to Settings later, so retry on
// DOM changes until the section mounts, then stop observing. Throttled
// to one attempt per 500 ms so a busy SPA re-render cannot turn the
// heading scan into a hot loop.
if (typeof document !== "undefined"
  && typeof MutationObserver === "function") {
  let lastAttempt = 0;
  const tryMount = () => {
    const now = Date.now();
    if (now - lastAttempt < 500) return;
    lastAttempt = now;
    if (mountSearchSettings(document, undefined) !== null) {
      observer.disconnect();
    }
  };
  const observer = new MutationObserver(tryMount);
  tryMount();
  if (typeof document !== "undefined" && document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}
