#!/usr/bin/env node
/**
 * Harness — "Your Keys" Settings section (features/tinyfish/).
 *
 * The skill reads its key from Settings (env vars), and the "Your Keys"
 * section in Settings is where the user adds API keys and picks the
 * search features. This harness tests the section module
 * (pages/public/search-settings-ui.js) without a browser:
 *
 *   Static, on the real module source:
 *     - it uses PATCH /api/envs to save (never PUT, which would
 *       replace ALL environment variables);
 *     - it removes a key with DELETE /api/envs/<KEY>;
 *     - each key field is a password input with autocomplete="new-password";
 *     - it never references the vault (the keys live in Settings);
 *     - it never logs anything (no console.log of state).
 *   Dynamic, importing the real module in Node:
 *     - flagOn: "0"/"false"/"no"/"off" are off (any case); absent,
 *       empty, "1", "true" are on.
 *     - parseLoadResponse: returns hasKey + hasDrexKey + the three
 *       flags as booleans, and the returned object never contains a
 *       key value (it cannot be rendered or logged by a caller).
 *     - buildSaveBody: includes a key only when the user typed a
 *       non-empty value (an empty field leaves the saved key alone);
 *       flags are always sent as "1"/"0".
 *   Dynamic, with a minimal DOM mock + a fetch mock:
 *     - mount inserts the "Your Keys" section after the Environments
 *       heading and only once (a second mount is a no-op);
 *     - mount on the chat page (a <main> with no Environments heading
 *       and no Settings page) is a safe no-op — the old <main>
 *       fallback put the section at the bottom of the chat view;
 *     - mount with no Settings anchor is a safe no-op (null);
 *     - the section injects its own scoped styles once, and each key
 *       placeholder names where the key comes from;
 *     - after load, the checkboxes reflect the saved flags and each
 *       key state says "Key saved." while the inputs stay empty (the
 *       values are never placed in the DOM);
 *     - Save sends PATCH /api/envs with the flags and no key when the
 *       inputs are empty; with typed keys, the keys are in the PATCH
 *       body only, and the inputs are cleared after save;
 *     - each key's Remove sends DELETE /api/envs/<KEY>.
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
  KEY_ENV, DREX_KEY_ENV, FLAG_SEARCH_ENV, FLAG_FETCH_ENV, FLAG_DDG_ENV,
  ENVS_API, SECTION_ID, flagOn, parseLoadResponse, buildSaveBody,
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
check("remove uses DELETE /api/envs/<KEY> (per key)",
  SRC.includes('ENVS_API + "/" + envName') && SRC.includes('method: "DELETE"'));
check("key fields are password inputs with autocomplete new-password",
  SRC.includes('type: "password"') && SRC.includes('autocomplete: "new-password"'));
check("module never references the vault",
  !SRC.toLowerCase().includes("vault"));
check("module never logs anything",
  !SRC.includes("console.log") && !SRC.includes("console.info"));
check("module never puts a key in a URL",
  !SRC.includes("?key=") && !SRC.includes("TINYFISH_API_KEY=")
  && !SRC.includes("NACE_API_KEY="));
check("section is 'Your Keys' and lists what each key is for",
  SRC.includes('"Your Keys"') && SRC.includes("app.monid.ai")
  && SRC.includes("console.nace.ai"));
check("Drex key is NACE_API_KEY (the env var decide.py reads)",
  SRC.includes('DREX_KEY_ENV = "NACE_API_KEY"'));
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
  { key: "NACE_API_KEY", value: "nace-test-value-67890" },
  { key: "TINYFISH_SEARCH", value: "0" },
  { key: "TINYFISH_FETCH", value: "1" },
]);
check("parseLoadResponse: hasKey + hasDrexKey true, flags read",
  loaded.hasKey === true && loaded.hasDrexKey === true
  && loaded.search === false
  && loaded.fetch === true && loaded.ddg === true);
check("parseLoadResponse: returned object never holds a key value",
  !JSON.stringify(loaded).includes("sk-test-value-12345")
  && !JSON.stringify(loaded).includes("nace-test-value-67890"));
const loadedEmpty = parseLoadResponse([]);
check("parseLoadResponse: no keys and no flags = defaults on",
  loadedEmpty.hasKey === false && loadedEmpty.hasDrexKey === false
  && loadedEmpty.search === true
  && loadedEmpty.fetch === true && loadedEmpty.ddg === true);

const bodyNoKey = buildSaveBody({
  keyTyped: "", drexKeyTyped: "", search: true, fetch: false, ddg: true,
});
check("buildSaveBody: empty key fields leave both keys out",
  !(KEY_ENV in bodyNoKey) && !(DREX_KEY_ENV in bodyNoKey)
  && bodyNoKey[FLAG_SEARCH_ENV] === "1"
  && bodyNoKey[FLAG_FETCH_ENV] === "0"
  && bodyNoKey[FLAG_DDG_ENV] === "1");
const bodyKey = buildSaveBody({
  keyTyped: "  sk-typed-999  ", drexKeyTyped: "  nace-typed-888  ",
  search: false, fetch: true, ddg: false,
});
check("buildSaveBody: typed keys are trimmed and included, flags 1/0",
  bodyKey[KEY_ENV] === "sk-typed-999"
  && bodyKey[DREX_KEY_ENV] === "nace-typed-888"
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
  const head = makeEl("head");
  for (const child of rootChildren) body.appendChild(child);
  const doc = {
    body,
    head,
    createElement(tag) { return makeEl(tag); },
    getElementById(id) {
      return walk(body, []).concat(walk(head, [])).find(
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
    { key: "NACE_API_KEY", value: "nace-live-value-888" },
    { key: "TINYFISH_SEARCH", value: "0" },
    { key: "TINYFISH_FETCH", value: "1" },
    { key: "TINYFISH_DDG_IA", value: "0" },
  ]);
  const section = mountSearchSettings(doc, fetchMock);
  check("mount appends 'Your Keys' to the settings content column (aligned with the cards)",
    section !== null && section.attributes.id === SECTION_ID
    && page.children.includes(section)
    && section.parentElement === page);
  check("mount twice is a no-op (one section only)",
    mountSearchSettings(doc, fetchMock) === null
    && page.children.filter((c) => c.attributes.id === SECTION_ID).length === 1);
  await tick();
  const keyInput = doc.getElementById("qwenpaw-tinyfish-key");
  const keyState = doc.getElementById("qwenpaw-tinyfish-key-state");
  const drexInput = doc.getElementById("qwenpaw-drex-key");
  const drexState = doc.getElementById("qwenpaw-drex-key-state");
  check("load: both key states say saved, inputs stay empty (values never in DOM)",
    keyState && keyState.textContent === "Key saved."
    && drexState && drexState.textContent === "Key saved."
    && keyInput && keyInput.value === ""
    && drexInput && drexInput.value === "");
  const searchBox = doc.getElementById("qwenpaw-tinyfish-search");
  const fetchBox = doc.getElementById("qwenpaw-tinyfish-fetch");
  const ddgBox = doc.getElementById("qwenpaw-tinyfish-ddg");
  check("load: checkboxes reflect the saved flags",
    searchBox.checked === false && fetchBox.checked === true
    && ddgBox.checked === false);

  // Save with empty key fields: PATCH with flags, neither key.
  const saveBtn = section.children
    .flatMap((row) => row.children || [])
    .find((n) => n.tagName === "BUTTON" && n.textContent === "Save");
  saveBtn.click();
  await tick();
  const patch = fetchMock.calls.find((c) => c.method === "PATCH");
  const patchBody = patch ? JSON.parse(patch.body) : {};
  check("save: PATCH /api/envs, flags sent, both keys omitted when inputs empty",
    patch && patch.url === ENVS_API
    && patchBody[FLAG_SEARCH_ENV] === "0"
    && patchBody[FLAG_FETCH_ENV] === "1"
    && patchBody[FLAG_DDG_ENV] === "0"
    && !(KEY_ENV in patchBody) && !(DREX_KEY_ENV in patchBody));

  // Save with typed keys: both keys in the PATCH body only, inputs cleared.
  keyInput.value = "sk-typed-abc";
  drexInput.value = "nace-typed-def";
  saveBtn.click();
  await tick();
  const patch2 = fetchMock.calls.filter((c) => c.method === "PATCH").pop();
  const patchBody2 = patch2 ? JSON.parse(patch2.body) : {};
  check("save: typed keys are in the PATCH body and the inputs are cleared",
    patchBody2[KEY_ENV] === "sk-typed-abc"
    && patchBody2[DREX_KEY_ENV] === "nace-typed-def"
    && keyInput.value === "" && drexInput.value === "");
  check("the key values never appear in any GET call",
    fetchMock.calls.filter((c) => c.method === "GET")
      .every((c) => !c.url.includes("sk-") && !c.url.includes("nace-")));

  // Each key has its own Remove button: DELETE /api/envs/<KEY>.
  const removeFor = (input) => (input.parentElement.children || [])
    .find((n) => n.tagName === "BUTTON" && n.textContent === "Remove");
  const removeTinyfish = removeFor(keyInput);
  removeTinyfish.click();
  await tick();
  check("remove TinyFish: DELETE /api/envs/TINYFISH_API_KEY",
    fetchMock.calls.some((c) => c.method === "DELETE"
      && c.url === ENVS_API + "/" + KEY_ENV));
  const removeDrex = removeFor(drexInput);
  removeDrex.click();
  await tick();
  check("remove Drex: DELETE /api/envs/NACE_API_KEY",
    fetchMock.calls.some((c) => c.method === "DELETE"
      && c.url === ENVS_API + "/" + DREX_KEY_ENV));
}

{
  // No Settings anchor at all: safe no-op, no section, no fetch.
  const emptyDoc = makeDoc([makeEl("div")]);
  const fetchMock = makeFetch([]);
  check("mount with no Settings anchor is a safe no-op",
    mountSearchSettings(emptyDoc, fetchMock) === null
    && fetchMock.calls.length === 0);
}

{
  // REGRESSION (2026-11-18 screenshot): the chat page has a <main>
  // element but no Environments heading and no Settings page, and the
  // old code fell back to <main> — so the Search section rendered at
  // the bottom of the chat view, under the message input, unstyled.
  // It must NOT mount there.
  const main = makeEl("main");
  const chatDiv = makeEl("div");
  chatDiv.appendChild(makeText("GitHub Account Access Inquiry"));
  main.appendChild(chatDiv);
  const chatDoc = makeDoc([main]);
  const fetchMock = makeFetch([]);
  check("mount on the chat page (main, no Environments) is a no-op",
    mountSearchSettings(chatDoc, fetchMock) === null
    && fetchMock.calls.length === 0
    && chatDoc.getElementById(SECTION_ID) === null);
}

{
  // Styles + placeholders on a real mount.
  const { doc } = settingsDoc();
  const fetchMock = makeFetch([]);
  const section = mountSearchSettings(doc, fetchMock);
  const style = doc.getElementById("qwenpaw-search-settings-style");
  check("mount injects the section styles once (scoped to the section)",
    section !== null && style !== null && style.tagName === "STYLE"
    && style.textContent.includes("#qwenpawYourKeys")
    && style.textContent.includes(".qwenpaw-key-block")
    && style.textContent.includes(".qwenpaw-search-row")
    && style.textContent.includes("flex-direction:column"));
  const keyInput = doc.getElementById("qwenpaw-tinyfish-key");
  const drexInput = doc.getElementById("qwenpaw-drex-key");
  check("key placeholders name where each key comes from",
    keyInput && keyInput.attributes.placeholder
    && keyInput.attributes.placeholder.includes("app.monid.ai")
    && !keyInput.attributes.placeholder.includes("agent.tinyfish.ai")
    && drexInput && drexInput.attributes.placeholder
    && drexInput.attributes.placeholder.includes("console.nace.ai"));
  // Each key block says what the key is for.
  const allText = walk(section, []).map((n) => n.textContent || "").join(" ");
  check("each key block states what it is for",
    allText.includes("Free live web search + page fetch")
    && allText.includes("Decision model for verdicts and triage"));
}

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log("failed:", failed.join("; "));
  process.exit(1);
}
