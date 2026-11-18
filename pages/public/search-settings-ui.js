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
export const FLAG_SEARCH_ENV = "TINYFISH_SEARCH";
export const FLAG_FETCH_ENV = "TINYFISH_FETCH";
export const FLAG_DDG_ENV = "TINYFISH_DDG_IA";
export const FEATURE_ENVS = [FLAG_SEARCH_ENV, FLAG_FETCH_ENV, FLAG_DDG_ENV];
export const ENVS_API = "/api/envs";
export const SECTION_ID = "qwenpawSearchSettings";

/** A flag env value: off only for "0"/"false"/"no"/"off" (any case). */
export function flagOn(value) {
  if (value === undefined || value === null) return true;
  const v = String(value).trim().toLowerCase();
  if (v === "") return true;
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/**
 * Parse a GET /api/envs response (a list of {key, value}) into the
 * form state. Returns {hasKey, search, fetch, ddg} — booleans only.
 * The key VALUE is never returned, so no caller can render or log it.
 */
export function parseLoadResponse(envList) {
  const byKey = {};
  for (const item of envList || []) {
    if (item && typeof item.key === "string") byKey[item.key] = item.value;
  }
  const keyVal = byKey[KEY_ENV];
  return {
    hasKey: typeof keyVal === "string" && keyVal.trim() !== "",
    search: flagOn(byKey[FLAG_SEARCH_ENV]),
    fetch: flagOn(byKey[FLAG_FETCH_ENV]),
    ddg: flagOn(byKey[FLAG_DDG_ENV]),
  };
}

/**
 * Build the PATCH /api/envs body from the form state.
 * state = {keyTyped, search, fetch, ddg}. The key is included ONLY when
 * the user typed a non-empty value (an empty field means "leave the
 * saved key alone", never "wipe it"). Flags are always sent as "1"/"0".
 */
export function buildSaveBody(state) {
  const body = {};
  const typed = (state.keyTyped || "").trim();
  if (typed !== "") body[KEY_ENV] = typed;
  body[FLAG_SEARCH_ENV] = state.search ? "1" : "0";
  body[FLAG_FETCH_ENV] = state.fetch ? "1" : "0";
  body[FLAG_DDG_ENV] = state.ddg ? "1" : "0";
  return body;
}

/** Find the element to insert the Search section after, or null. */
function findAnchor(doc) {
  // Prefer right after the Environments section (the key lives there
  // too). Match by visible heading text, not by hashed class names.
  const headings = doc.querySelectorAll
    ? doc.querySelectorAll("h1,h2,h3,h4,[role='heading']")
    : [];
  for (const h of headings) {
    const text = (h.textContent || "").trim().toLowerCase();
    if (text === "environments" || text === "environment variables") {
      // Climb to the section/card container, if one is identifiable.
      let el = h;
      for (let i = 0; i < 6 && el.parentElement; i++) {
        el = el.parentElement;
        const cls = (el.className || "").toString().toLowerCase();
        if (cls.includes("section") || cls.includes("card")
          || cls.includes("panel") || el.tagName === "SECTION") {
          return el;
        }
      }
      return h;
    }
  }
  // Fall back to the settings content area: an element whose heading
  // says Settings, else the main element, else null (safe no-op).
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

    const section = el(doc, "section", {
      id: SECTION_ID,
      "data-qwenpaw-search-settings": "true",
    });
    section.appendChild(el(doc, "h2", null, "Search"));
    section.appendChild(el(doc, "p", null,
      "TinyFish free web search + fetch. Add your API key once, then pick "
      + "which search features are on. With no key, the built-in search "
      + "is used exactly as now."));

    // Key row: password input + saved indicator (never the value).
    const keyRow = el(doc, "div", { className: "qwenpaw-search-row" });
    keyRow.appendChild(el(doc, "label", { for: "qwenpaw-tinyfish-key" },
      "TinyFish API key"));
    const keyInput = el(doc, "input", {
      id: "qwenpaw-tinyfish-key",
      type: "password",
      autocomplete: "new-password",
      placeholder: "Paste your key from agent.tinyfish.ai",
    });
    keyRow.appendChild(keyInput);
    const keyState = el(doc, "span", {
      id: "qwenpaw-tinyfish-key-state",
    }, "No key saved.");
    keyRow.appendChild(keyState);
    section.appendChild(keyRow);

    // Feature checkboxes.
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

    // Buttons + status.
    const saveBtn = el(doc, "button", { type: "button" }, "Save");
    const removeBtn = el(doc, "button", { type: "button" }, "Remove key");
    const status = el(doc, "span", { id: "qwenpaw-search-status" }, "");
    const btnRow = el(doc, "div", { className: "qwenpaw-search-row" });
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(removeBtn);
    btnRow.appendChild(status);
    section.appendChild(btnRow);

    const setStatus = (msg) => { status.textContent = msg; };

    // Load current state (presence of the key + flag values only).
    fetchFn(ENVS_API, { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        const state = parseLoadResponse(list);
        keyState.textContent = state.hasKey
          ? "Key saved." : "No key saved.";
        checks[0].checked = state.search;
        checks[1].checked = state.fetch;
        checks[2].checked = state.ddg;
      })
      .catch(() => setStatus("Could not load search settings."));

    saveBtn.addEventListener("click", () => {
      const body = buildSaveBody({
        keyTyped: keyInput.value,
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
          // Clear the typed key so it never sits in the input.
          keyInput.value = "";
          if (body[KEY_ENV]) {
            keyState.textContent = "Key saved.";
          }
          setStatus("Saved.");
        })
        .catch(() => setStatus("Save failed. Try again."));
    });

    removeBtn.addEventListener("click", () => {
      if (typeof confirm === "function"
        && !confirm("Remove the saved TinyFish key?")) return;
      fetchFn(ENVS_API + "/" + KEY_ENV, {
        method: "DELETE",
        credentials: "same-origin",
      })
        .then((res) => {
          if (!res.ok) throw new Error("remove failed: " + res.status);
          keyState.textContent = "No key saved.";
          setStatus("Key removed.");
        })
        .catch(() => setStatus("Remove failed. Try again."));
    });

    // Insert after the anchor (or append inside it when it is a main).
    if (anchor.parentElement && anchor.tagName !== "MAIN") {
      anchor.parentElement.insertBefore(section, anchor.nextSibling);
    } else {
      anchor.appendChild(section);
    }
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
