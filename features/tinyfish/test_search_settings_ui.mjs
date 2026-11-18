#!/usr/bin/env node
/**
 * Harness — TinyFish Settings search section (features/tinyfish/).
 *
 * The skill reads its key from Settings (env vars), and the Search
 * section in Settings is where the user adds the key and picks the
 * features. This harness tests the section module
 * (features/tinyfish/search-settings-ui.js) without a browser:
 *
 *   Static, on the real module source:
 *     - it uses PATCH /api/envs to save (never PUT, which would
 *       replace ALL environment variables);
 *     - it removes the key with DELETE /api/envs/TINYFISH_API_KEY;
 *     - the key field is a password input with autocomplete="new-password";
 *     - it never references the vault (the key lives in Settings);
 *     - it never logs anything (no console.log of state).
 *   Dynamic, importing the real module in Node:
 *     - flagOn: "0"/"false"/"no"/"off" are off (any case); absent,
 *       empty, "1", "true" are on.
 *     - parseLoadResponse: returns hasKey + the three flags as
 *       booleans, and the returned object never contains the key
 *       value (it cannot be rendered or logged by a caller).
 *     - buildSaveBody: includes the key only when the user typed a
 *       non-empty value (an empty field leaves the saved key alone);
 *       flags are always sent as "1"/"0".
 *   Dynamic, with a minimal DOM mock + a fetch mock:
 *     - mount inserts the section after the Environments heading and
 *       only once (a second mount is a no-op);
 *     - mount with no Settings anchor is a safe no-op (null);
 *     - after load, the checkboxes reflect the saved flags and the
 *       key state says "Key saved." while the key input stays empty
 *       (the value is never placed in the DOM);
 *     - Save sends PATCH /api/envs with the flags and no key when the
 *       input is empty; with a typed key, the key is in the PATCH
 *       body only, and the input is cleared after save;
 *     - Remove sends DELETE /api/envs/TINYFISH_API_KEY.
 *
 * The live half (the section in a real browser on the deployed
 * console: it appears in Settings, saves through PATCH /api/envs,
 * the skill then uses the key) is verified by Muse after deploy.
 *
 * Run: node features/tinyfish/test_search_settings_ui.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KEY_ENV, FLAG_SEARCH_ENV, FLAG_FETCH_ENV, FLAG_DDG_ENV, ENVS_API,
  SECTION_ID, flagOn, parseLoadResponse, buildSaveBody,
  mountSearchSettings,
} from "../../pages/public/search-settings-ui.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "..", "..", "pages", "public",
  "search-settings-ui.js"), "utf8");
const WORKER = readFileSync(resolve(HERE, "..", "..", "pages", "public",
  "_worker.js"), "utf8");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

// ---------- static checks on the module source ----------
check("save uses PATCH /api/envs (never PUT)",
  SRC.includes('method: "PATCH"') && !SRC.includes('method: "PUT"'));
check("remove uses DELETE /api/envs/TINYFISH_API_KEY",
  SRC.includes('ENVS_API + "/" + KEY_ENV') && SRC.includes('method: "DELETE"'));
check("key field is a password input with autocomplete new-password",
  SRC.includes('type: "password"') && SRC.includes('autocomplete: "new-password"'));
check("module never references the vault",
  !SRC.toLowerCase().includes("vault"));
check("module never logs anything",
  !SRC.includes("console.log") && !SRC.includes("console.info"));
check("module never puts the key in a URL",
  !SRC.includes("?key=") && !SRC.includes("TINYFISH_API_KEY="));
check("self-mount is browser-only (skipped when document is undefined)",
  SRC.includes('typeof document !== "undefined"'));
check("self-mount retries on DOM changes and stops once mounted",
  SRC.includes("new MutationObserver")
  && SRC.includes("observer.disconnect()"));
check("self-mount is throttled (no hot loop on SPA re-renders)",
  SRC.includes("lastAttempt") && SRC.includes("< 500"));

// _worker.js wiring: the module is a Pages static asset, and a bare
// <script src> for an unrouted path falls through to the console proxy,
// which answers with the SPA HTML (B-35) — so the worker must route the
// asset explicitly AND inject the script tag into the console HTML.
check("_worker.js routes /search-settings-ui.js to the Pages assets",
  WORKER.includes('"/search-settings-ui.js"')
  && WORKER.includes("env.ASSETS.fetch"));
check("_worker.js injects the module script into the console HTML",
  WORKER.includes('<script type="module" src="/search-settings-ui.js">'));

// ---------- pure functions ----------
check("flagOn: 0/false/no/off are off (any case)",
  !flagOn("0") && !flagOn("false") && !flagOn("FALSE")
  && !flagOn("no") && !flagOn("off") && !flagOn("Off"));
check("flagOn: absent/empty/1/true/yes are on",
  flagOn(undefined) && flagOn(null) && flagOn("") && flagOn("  ")
  && flagOn("1") && flagOn("true") && flagOn("TRUE") && flagOn("yes"));

const loaded = parseLoadResponse([
  { key: "TINYFISH_API_KEY", value: "sk-test-value-12345" },
  { key: "TINYFISH_SEARCH", value: "0" },
  { key: "TINYFISH_FETCH", value: "1" },
]);
check("parseLoadResponse: hasKey true, flags read",
  loaded.hasKey === true && loaded.search === false
  && loaded.fetch === true && loaded.ddg === true);
check("parseLoadResponse: returned object never holds the key value",
  !JSON.stringify(loaded).includes("sk-test-value-12345"));
const loadedEmpty = parseLoadResponse([]);
check("parseLoadResponse: no key and no flags = defaults on",
  loadedEmpty.hasKey === false && loadedEmpty.search === true
  && loadedEmpty.fetch === true && loadedEmpty.ddg === true);

const bodyNoKey = buildSaveBody({
  keyTyped: "", search: true, fetch: false, ddg: true,
});
check("buildSaveBody: empty key field leaves the key out",
  !(KEY_ENV in bodyNoKey)
  && bodyNoKey[FLAG_SEARCH_ENV] === "1"
  && bodyNoKey[FLAG_FETCH_ENV] === "0"
  && bodyNoKey[FLAG_DDG_ENV] === "1");
const bodyKey = buildSaveBody({
  keyTyped: "  sk-typed-999  ", search: false, fetch: true, ddg: false,
});
check("buildSaveBody: typed key is trimmed and included, flags 1/0",
  bodyKey[KEY_ENV] === "sk-typed-999"
  && bodyKey[FLAG_SEARCH_ENV] === "0"
  && bodyKey[FLAG_FETCH_ENV] === "1"
  && bodyKey[FLAG_DDG_ENV] === "0");

// ---------- minimal DOM mock ----------
function makeText(text) {
  return { nodeType: 3, textContent: text, parentElement: null };
}
function makeEl(tag) {
  const elNode = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    children: [],
    attributes: {},
    className: "",
    dataset: {},
    style: {},
    checked: false,
    value: "",
    textContent: "",
    parentElement: null,
    nextSibling: null,
    _handlers: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k]; },
    addEventListener(type, fn) { this._handlers[type] = fn; },
    click() { if (this._handlers.click) this._handlers.click(); },
    appendChild(child) {
      child.parentElement = this;
      const last = this.children[this.children.length - 1];
      if (last) last.nextSibling = child;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentElement = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx === -1) this.children.push(child);
      else this.children.splice(idx, 0, child);
      // Rebuild nextSibling links.
      for (let i = 0; i < this.children.length; i++) {
        this.children[i].nextSibling = this.children[i + 1] || null;
      }
      return child;
    },
  };
  Object.defineProperty(elNode, "textContent", {
    get() {
      if (this._text !== undefined) return this._text;
      return this.children.map((c) => c.textContent || "").join("");
    },
    set(v) { this._text = String(v); },
    configurable: true,
  });
  return elNode;
}
function walk(node, out) {
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
}
function makeDoc(rootChildren) {
  const body = makeEl("body");
  for (const child of rootChildren) body.appendChild(child);
  const doc = {
    body,
    createElement(tag) { return makeEl(tag); },
    getElementById(id) {
      return walk(body, []).find(
        (n) => n.attributes && n.attributes.id === id) || null;
    },
    querySelectorAll(sel) {
      const parts = sel.split(",").map((s) => s.trim());
      const all = walk(body, []);
      return all.filter((n) => {
        if (n.nodeType !== 1) return false;
        return parts.some((p) => {
          if (p.startsWith("[role='heading']")) {
            return n.attributes.role === "heading";
          }
          if (p.startsWith("[role='main']")) {
            return n.attributes.role === "main";
          }
          return n.tagName.toLowerCase() === p;
        });
      });
    },
    querySelector(sel) {
      const found = this.querySelectorAll(sel);
      return found[0] || null;
    },
  };
  return doc;
}
function makeFetch(envList) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body });
    if ((opts.method || "GET") === "GET") {
      return { ok: true, json: async () => envList };
    }
    return { ok: true, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}
const tick = () => new Promise((r) => setTimeout(r, 10));

// Settings page mock: an Environments heading inside a section div.
function settingsDoc() {
  const envSection = makeEl("div");
  envSection.className = "env-section";
  const heading = makeEl("h2");
  heading.appendChild(makeText("Environments"));
  envSection.appendChild(heading);
  const page = makeEl("div");
  page.appendChild(envSection);
  return { doc: makeDoc([page]), envSection, page };
}

{
  const { doc, page } = settingsDoc();
  const fetchMock = makeFetch([
    { key: "TINYFISH_API_KEY", value: "sk-live-value-777" },
    { key: "TINYFISH_SEARCH", value: "0" },
    { key: "TINYFISH_FETCH", value: "1" },
    { key: "TINYFISH_DDG_IA", value: "0" },
  ]);
  const section = mountSearchSettings(doc, fetchMock);
  check("mount inserts the Search section after Environments",
    section !== null && section.attributes.id === SECTION_ID
    && page.children.includes(section));
  check("mount twice is a no-op (one section only)",
    mountSearchSettings(doc, fetchMock) === null
    && page.children.filter((c) => c.attributes.id === SECTION_ID).length === 1);
  await tick();
  const keyInput = doc.getElementById("qwenpaw-tinyfish-key");
  const keyState = doc.getElementById("qwenpaw-tinyfish-key-state");
  check("load: key state says saved, input stays empty (value never in DOM)",
    keyState && keyState.textContent === "Key saved."
    && keyInput && keyInput.value === "");
  const searchBox = doc.getElementById("qwenpaw-tinyfish-search");
  const fetchBox = doc.getElementById("qwenpaw-tinyfish-fetch");
  const ddgBox = doc.getElementById("qwenpaw-tinyfish-ddg");
  check("load: checkboxes reflect the saved flags",
    searchBox.checked === false && fetchBox.checked === true
    && ddgBox.checked === false);

  // Save with an empty key field: PATCH with flags, no key.
  const saveBtn = section.children
    .flatMap((row) => row.children || [])
    .find((n) => n.tagName === "BUTTON" && n.textContent === "Save");
  saveBtn.click();
  await tick();
  const patch = fetchMock.calls.find((c) => c.method === "PATCH");
  const patchBody = patch ? JSON.parse(patch.body) : {};
  check("save: PATCH /api/envs, flags sent, key omitted when input empty",
    patch && patch.url === ENVS_API
    && patchBody[FLAG_SEARCH_ENV] === "0"
    && patchBody[FLAG_FETCH_ENV] === "1"
    && patchBody[FLAG_DDG_ENV] === "0"
    && !(KEY_ENV in patchBody));

  // Save with a typed key: key in the PATCH body only, input cleared.
  keyInput.value = "sk-typed-abc";
  saveBtn.click();
  await tick();
  const patch2 = fetchMock.calls.filter((c) => c.method === "PATCH").pop();
  const patchBody2 = patch2 ? JSON.parse(patch2.body) : {};
  check("save: typed key is in the PATCH body and the input is cleared",
    patchBody2[KEY_ENV] === "sk-typed-abc" && keyInput.value === "");
  check("the key value never appears in any GET call",
    fetchMock.calls.filter((c) => c.method === "GET")
      .every((c) => !c.url.includes("sk-")));

  // Remove: DELETE the key env var.
  const removeBtn = section.children
    .flatMap((row) => row.children || [])
    .find((n) => n.tagName === "BUTTON" && n.textContent === "Remove key");
  removeBtn.click();
  await tick();
  check("remove: DELETE /api/envs/TINYFISH_API_KEY",
    fetchMock.calls.some((c) => c.method === "DELETE"
      && c.url === ENVS_API + "/" + KEY_ENV));
}

{
  // No Settings anchor at all: safe no-op, no section, no fetch.
  const emptyDoc = makeDoc([makeEl("div")]);
  const fetchMock = makeFetch([]);
  check("mount with no Settings anchor is a safe no-op",
    mountSearchSettings(emptyDoc, fetchMock) === null
    && fetchMock.calls.length === 0);
}

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log("failed:", failed.join("; "));
  process.exit(1);
}
