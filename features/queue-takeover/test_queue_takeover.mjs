// T145 — multi-tab takeover (Step 10, 2026-11-19).
//
// Four parts, all machine-free:
//   (a) The bundle patch (features/queue-takeover/apply-queue-takeover.py)
//       is run FOR REAL against the verbatim live excerpts captured from
//       the machine (image qwenpaw-agentx:2.3.0-approvalttl1, both asset
//       copies byte-identical): the shared-chunk channel listener and
//       the chat-chunk hold effect. The patched output must contain the
//       new code and parse (node --check); a second run on patched
//       output must FAIL (fail-closed, no double-patch). The full-file
//       proof happens at image build time (the Dockerfile applies the
//       same script to the real 1MB bundles and node --checks them).
//   (b) Static checks on the "queue-takeover" rule in
//       pages/public/_worker.js.
//   (c) Dynamic checks: the rule, run in a DOM mock, adds exactly one
//       "Take over sending" button to the queue-only banner, posts
//       {type:"release-ownership", sessionId} on click, and hides /
//       restores the dead "Interrupt & send" button with the banner.
//       The mock models the REAL banner DOM (nested divs, live
//       textContent) and React re-renders, because the takeover1 live
//       failure was the rule creating THREE buttons: the old
//       anchor-scoped guard (banner.querySelector) let each observer
//       run pick a different nested banner div as the appended button
//       lengthened the previous winner.
//   (d) The cache bust (features/queue-takeover/rename-chunks-tk2.py):
//       takeover1 patched the content-hashed bundles IN PLACE, while
//       Pages serves /assets/* as immutable for a year — a tab that had
//       loaded the console before kept running the OLD bundle, whose
//       listener has no release-ownership branch. Takeover2 gives the
//       two patched chunks fresh URLs (entry ?v=takeover2, chat chunk
//       renamed). The rename script is run FOR REAL on fixture console
//       dirs; a second run must FAIL. The full-file proof happens at
//       image build time (Dockerfile.takeover2 runs the script on the
//       real bundles and node --checks them; the script itself was
//       dry-run on the real downloaded bundles before this test was
//       written).
//
// The live half (two tabs on the same chat, send from the non-owner tab,
// confirm takeover works and the queue drains) runs in a real browser
// after the container redeploy — NOT here.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workerJs = fs.readFileSync(path.join(repo, "pages/public/_worker.js"), "utf8");
const applyPy = fs.readFileSync(
  path.join(repo, "features/queue-takeover/apply-queue-takeover.py"), "utf8");
const dockerfile = fs.readFileSync(
  path.join(repo, "features/queue-takeover/Dockerfile.takeover1"), "utf8");
const dockerfile2 = fs.readFileSync(
  path.join(repo, "features/queue-takeover/Dockerfile.takeover2"), "utf8");
const renamePy = fs.readFileSync(
  path.join(repo, "features/queue-takeover/rename-chunks-tk2.py"), "utf8");

// Verbatim live excerpts (captured from the machine 2026-11-19, image
// qwenpaw-agentx:2.3.0-approvalttl1). The shared excerpt is the whole
// BroadcastChannel message listener statement; the chat excerpt is the
// whole hold-ownership useEffect statement. Both parse standalone.
const SHARED_EXCERPT = 'if(typeof window<"u"){const e=$y();e&&e.addEventListener("message",t=>{const n=t.data;if(!n||typeof n!=="object")return;const o=ao.getState();if(n.type==="migrate"){o.applyRemoteItems(n.sessionId,n.sourceItems??[]),n.toSessionId&&n.items&&(n.runState&&o.applyRemoteRunState(n.toSessionId,n.runState),o.applyRemoteItems(n.toSessionId,n.items));return}if(n.type==="runState"&&n.runState){ao.getState().applyRemoteRunState(n.sessionId,n.runState);return}n.runState&&o.applyRemoteRunState(n.sessionId,n.runState),n.items&&o.applyRemoteItems(n.sessionId,n.items)})}';
const CHAT_EXCERPT = 'c.useEffect(()=>{Zs(!1),ts(!1);const o=new AbortController;let m=!1,h;const y=()=>{m||o.signal.aborted||_||!w.isReady(x)||(m=!0,Qa(p,o.signal).then(()=>{if(!o.signal.aborted)return Va(p,()=>{Zs(!0),ts(!0)},o.signal)}).catch(N=>{o.signal.aborted||console.error("Unable to recover chat queue",N)}),h=setTimeout(()=>ts(!0),300))},I=w.subscribe(y);return y(),()=>{o.abort(),I(),clearTimeout(h)}},[x,p,w,_]);';

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; }
  else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---- (b) static checks on the rule (before the dynamic run) ----
const ruleStart = workerJs.indexOf('{ id: "queue-takeover"');
const ruleEnd = workerJs.indexOf('{ id: "settings-white-area"', ruleStart);
const ruleSrc = ruleStart !== -1 && ruleEnd !== -1
  ? workerJs.slice(ruleStart, ruleEnd).trim().replace(/,\s*$/, "")
  : null;
check("the queue-takeover rule exists in AGENTX_RULES", ruleSrc !== null);
check("the apply script defines the shared-chunk anchor + release-ownership branch",
  applyPy.includes('const o=ao.getState();if(n.type==="migrate"){') &&
  applyPy.includes('if(n.type==="release-ownership"){'));
check("the apply script defines the chat-chunk register anchor",
  applyPy.includes('const o=new AbortController;let m=!1,h;') &&
  applyPy.includes('window.__agentxOwnerControllers'));
check("the apply script defines the chat-chunk cleanup anchor",
  applyPy.includes('return y(),()=>{o.abort(),I(),clearTimeout(h)}},[x,p,w,_]);') &&
  // The replacement is split across Python string literals in the file,
  // so the joined form is tested fragment by fragment.
  applyPy.includes('window.__agentxOwnerControllers&&') &&
  applyPy.includes('window.__agentxOwnerControllers.delete(p),'));
check("the apply script fails unless each anchor occurs exactly once",
  applyPy.includes('if count != 1:') && applyPy.includes('return False'));
check("the rule posts release-ownership on BroadcastChannel(\"qwenpaw:queue\")",
  ruleSrc !== null &&
  ruleSrc.includes('new BroadcastChannel("qwenpaw:queue")') &&
  ruleSrc.includes('type: "release-ownership"') &&
  ruleSrc.includes('sessionId: chatId'));
check("the rule creates the button with the takeover marker + label",
  ruleSrc !== null &&
  ruleSrc.includes('setAttribute("data-agentx-takeover", "1")') &&
  ruleSrc.includes('"Take over sending"'));
check("the rule hides the dead Interrupt button while the banner is up",
  ruleSrc !== null &&
  ruleSrc.includes('indexOf("Interrupt")') &&
  ruleSrc.includes('data-agentx-interrupt-hidden'));
check("the rule never removes React nodes (no removeChild on React content)",
  ruleSrc !== null &&
  // One removeChild is allowed: removing OUR OWN stranded button when the
  // banner is gone. React nodes are never removed.
  (ruleSrc.match(/removeChild/g) || []).length === 1 &&
  ruleSrc.includes('removeChild(existing)') &&
  !ruleSrc.includes("innerHTML"));
check("the rule uses a DOCUMENT-WIDE guard (one button in the whole document)",
  ruleSrc !== null &&
  ruleSrc.includes('document.querySelector("[data-agentx-takeover]")'));
check("the old anchor-scoped guard is gone (it caused the 3x live failure)",
  ruleSrc !== null &&
  !ruleSrc.includes('banner.querySelector("[data-agentx-takeover]")'));
check("the rule MOVES the existing button onto the current banner (no second button)",
  ruleSrc !== null &&
  ruleSrc.includes('root.appendChild(existing)'));
check("the button goes on the banner root with white-space:nowrap (no truncation)",
  ruleSrc !== null &&
  ruleSrc.includes('white-space:nowrap') &&
  ruleSrc.includes('root.appendChild(btn)'));
check("the rule removes a stranded button when the banner is gone",
  ruleSrc !== null &&
  ruleSrc.includes('removeChild(existing)'));
check("the rule never polls: no setInterval anywhere",
  ruleSrc !== null && !ruleSrc.includes("setInterval"));
check("exactly one setTimeout, inside the click handler (15s retry re-enable)",
  ruleSrc !== null &&
  (ruleSrc.match(/setTimeout/g) || []).length === 1 &&
  ruleSrc.indexOf("setTimeout") > ruleSrc.indexOf('addEventListener("click"'));
check("the rule is in the immediate-run list",
  workerJs.includes('agentxRunRuleNow("queue-takeover")'));
check("the Dockerfile builds FROM the live image, patches both copies, node --checks both",
  dockerfile.includes("FROM qwenpaw-agentx:2.3.0-approvalttl1") &&
  dockerfile.includes("apply-queue-takeover.py") &&
  dockerfile.includes("/app/src/qwenpaw/console/assets/index-DZrIuh3B.js") &&
  dockerfile.includes("/app/venv/lib/python3.11/site-packages/qwenpaw/console/assets/index-DZrIuh3B.js") &&
  dockerfile.includes("node --check"));
check("the takeover2 Dockerfile builds FROM takeover1 (never re-applies the patch)",
  dockerfile2.includes("FROM qwenpaw-agentx:2.3.0-takeover1") &&
  !dockerfile2.includes("apply-queue-takeover.py"));
check("the takeover2 Dockerfile runs the rename script on BOTH console copies",
  dockerfile2.includes("rename-chunks-tk2.py") &&
  dockerfile2.includes("/app/src/qwenpaw/console") &&
  dockerfile2.includes("/app/venv/lib/python3.11/site-packages/qwenpaw/console"));
check("the takeover2 Dockerfile node --checks the renamed files + verifies the bust",
  dockerfile2.includes("index-opcB8AGu-tk2.js") &&
  dockerfile2.includes("node --check") &&
  dockerfile2.includes("index-DZrIuh3B.js?v=takeover2") &&
  dockerfile2.includes("index-opcB8AGu\\.js"));
check("the rename script defines the entry-query + chat-rename anchors",
  // Anchors are built by concatenation in the script (SHARED / OLD_CHAT
  // constants), so the fragments are tested, not one joined literal.
  renamePy.includes('src="/assets/') &&
  renamePy.includes('SHARED = "index-DZrIuh3B.js"') &&
  renamePy.includes('?v=takeover2') &&
  renamePy.includes('index-opcB8AGu-tk2.js') &&
  renamePy.includes('from"./')); 
check("the rename script fails unless each anchor occurs exactly once",
  renamePy.includes('if count != 1:') && renamePy.includes('return False'));
check("the rename script verifies the old name is gone + the versioned entry is twice",
  renamePy.includes('old name') && renamePy.includes('if hits != 2:'));

// ---- (a) run the apply script for real on the verbatim excerpts ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t145-"));
const sharedFile = path.join(tmp, "index-DZrIuh3B.js");
const chatFile = path.join(tmp, "index-opcB8AGu.js");
fs.writeFileSync(sharedFile, SHARED_EXCERPT);
fs.writeFileSync(chatFile, CHAT_EXCERPT);
let applyOk = false, applyErr = "";
try {
  execFileSync("python3",
    [path.join(repo, "features/queue-takeover/apply-queue-takeover.py"), sharedFile, chatFile],
    { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
  applyOk = true;
} catch (e) { applyErr = String(e.status ?? e.message); }
check("the apply script exits 0 on the verbatim live excerpts", applyOk, applyErr);
const sharedPatched = fs.readFileSync(sharedFile, "utf8");
const chatPatched = fs.readFileSync(chatFile, "utf8");
check("patched shared excerpt contains the release-ownership branch",
  sharedPatched.includes('if(n.type==="release-ownership")') &&
  sharedPatched.includes('window.__agentxOwnerControllers.get(n.sessionId)') &&
  sharedPatched.includes('if(c)c.abort();return}'));
check("patched chat excerpt registers the controller in the registry",
  chatPatched.includes('(window.__agentxOwnerControllers||(window.__agentxOwnerControllers=new Map())).set(p,o);'));
check("patched chat excerpt deletes the chat id in the effect cleanup",
  chatPatched.includes('window.__agentxOwnerControllers&&window.__agentxOwnerControllers.delete(p),I(),clearTimeout(h)'));
let parseOk = false;
try {
  execFileSync("node", ["--check", sharedFile], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("node", ["--check", chatFile], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
  parseOk = true;
} catch (e) { /* parse failure recorded by the check below */ }
check("both patched excerpts parse (node --check)", parseOk);
let secondRunFails = false;
try {
  execFileSync("python3",
    [path.join(repo, "features/queue-takeover/apply-queue-takeover.py"), sharedFile, chatFile],
    { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
} catch (e) { secondRunFails = (e.status ?? 0) !== 0; }
check("a second run on patched output FAILS (fail-closed, no double-patch)", secondRunFails);
fs.rmSync(tmp, { recursive: true, force: true });

// ---- (d) run the rename script for real on fixture console dirs ----
{
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), "t145-rename-"));
  const fixAssets = path.join(fix, "assets");
  fs.mkdirSync(fixAssets);
  fs.writeFileSync(path.join(fix, "index.html"),
    '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-DZrIuh3B.js"></script></head></html>');
  fs.writeFileSync(path.join(fixAssets, "index-DZrIuh3B.js"),
    'const manifest=["assets/index-opcB8AGu.js"];\nconst load=()=>import("./index-opcB8AGu.js");\nexport { manifest, load };\n');
  fs.writeFileSync(path.join(fixAssets, "TerminalView-Ik57q2nE.js"),
    'import{s as ct}from"./index-opcB8AGu.js";\nexport default ct;\n');
  fs.writeFileSync(path.join(fixAssets, "index-opcB8AGu.js"),
    'import{Va}from"./index-DZrIuh3B.js";\nexport default Va;\n');
  let renameOk = false, renameErr = "";
  try {
    execFileSync("python3",
      [path.join(repo, "features/queue-takeover/rename-chunks-tk2.py"), fix],
      { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
    renameOk = true;
  } catch (e) { renameErr = String(e.status ?? e.message); }
  check("the rename script exits 0 on the fixture console dir", renameOk, renameErr);
  const htmlAfter = fs.readFileSync(path.join(fix, "index.html"), "utf8");
  const sharedAfter = fs.readFileSync(path.join(fixAssets, "index-DZrIuh3B.js"), "utf8");
  const termAfter = fs.readFileSync(path.join(fixAssets, "TerminalView-Ik57q2nE.js"), "utf8");
  check("the entry script gains ?v=takeover2 in index.html",
    htmlAfter.includes('src="/assets/index-DZrIuh3B.js?v=takeover2"'));
  check("the chat chunk is renamed (old file gone, new file present)",
    !fs.existsSync(path.join(fixAssets, "index-opcB8AGu.js")) &&
    fs.existsSync(path.join(fixAssets, "index-opcB8AGu-tk2.js")));
  const chatAfter = fs.readFileSync(path.join(fixAssets, "index-opcB8AGu-tk2.js"), "utf8");
  check("the shared chunk references the renamed chat chunk (manifest + dynamic import)",
    sharedAfter.includes('"assets/index-opcB8AGu-tk2.js"') &&
    sharedAfter.includes('"./index-opcB8AGu-tk2.js"'));
  check("TerminalView imports the renamed chat chunk",
    termAfter.includes('from"./index-opcB8AGu-tk2.js"'));
  check("the renamed chat chunk imports the versioned shared chunk",
    chatAfter.includes('from"./index-DZrIuh3B.js?v=takeover2"'));
  check("the old chat-chunk name occurs zero times across the touched files",
    !htmlAfter.includes("index-opcB8AGu.js") &&
    !sharedAfter.includes("index-opcB8AGu.js") &&
    !termAfter.includes("index-opcB8AGu.js") &&
    !chatAfter.includes("index-opcB8AGu.js"));
  let renameParseOk = false;
  try {
    for (const f of ["index-DZrIuh3B.js", "index-opcB8AGu-tk2.js", "TerminalView-Ik57q2nE.js"]) {
      execFileSync("node", ["--check", path.join(fixAssets, f)],
        { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
    }
    renameParseOk = true;
  } catch (e) { /* recorded below */ }
  check("all three renamed/touched files parse (node --check)", renameParseOk);
  let renameSecondFails = false;
  try {
    execFileSync("python3",
      [path.join(repo, "features/queue-takeover/rename-chunks-tk2.py"), fix],
      { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { renameSecondFails = (e.status ?? 0) !== 0; }
  check("a second rename run FAILS (fail-closed, no double-rename)", renameSecondFails);
  fs.rmSync(fix, { recursive: true, force: true });
}

// ---- (c) dynamic checks: the rule in a DOM mock ----
// Minimal DOM: elements with children/parentElement, LIVE textContent
// (a parent's text is its own text plus its children's, as in a real
// DOM — the takeover1 failure turned on exactly this: appending the
// button lengthens the winning div, so the next run picks a different
// nested banner div), querySelector(All), createElement,
// addEventListener + click dispatch, isConnected, and a fake setTimeout
// the test fires by hand.
function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: null,
    attributes: {},
    style: {},
    _ownText: "",
    disabled: false,
    listeners: {},
    _isDocRoot: false,
    appendChild(child) {
      if (child.parentElement && child.parentElement !== this) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx !== -1) child.parentElement.children.splice(idx, 1);
      }
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      child.parentElement = null;
      return child;
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    querySelector(sel) {
      const attr = sel.startsWith("[") && sel.endsWith("]") ? sel.slice(1, -1) : null;
      if (!attr) return null;
      const walk = (node) => {
        for (const c of node.children) {
          if (c.attributes[attr] !== undefined) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    click() { for (const fn of this.listeners.click ?? []) fn.call(this); },
  };
  Object.defineProperty(el, "textContent", {
    get() {
      let s = this._ownText;
      for (const c of this.children) s += c.textContent;
      return s;
    },
    set(v) {
      this._ownText = String(v ?? "");
      for (const c of [...this.children]) this.removeChild(c);
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(el, "isConnected", {
    get() {
      let n = this;
      while (n.parentElement) n = n.parentElement;
      return !!n._isDocRoot;
    },
    enumerable: true,
    configurable: true,
  });
  return el;
}
function makeWorld({ pathname, withBanner = true }) {
  const posted = [];
  const timers = [];
  class FakeChannel {
    constructor(name) { this.name = name; }
    postMessage(msg) { posted.push(msg); }
  }
  const root = makeEl("div");
  root._isDocRoot = true;
  const banner = makeEl("div");
  banner.textContent = "This tab queues only; sending is handled by another tab";
  const bannerWrap = makeEl("div");
  if (withBanner) bannerWrap.appendChild(banner);
  root.appendChild(bannerWrap);
  const interruptBtn = makeEl("button");
  interruptBtn.textContent = "Interrupt & send";
  const composer = makeEl("div");
  composer.appendChild(interruptBtn);
  root.appendChild(composer);
  const collect = (el, tag, out = []) => {
    if (el.tagName === tag) out.push(el);
    for (const c of el.children) collect(c, tag, out);
    return out;
  };
  const findAttr = (el, attr) => {
    for (const c of el.children) {
      if (c.attributes[attr] !== undefined) return c;
      const hit = findAttr(c, attr);
      if (hit) return hit;
    }
    return null;
  };
  const doc = {
    body: makeEl("body"),
    documentElement: root,
    querySelectorAll(sel) {
      if (sel === "div") return collect(root, "DIV");
      if (sel === "button") return collect(root, "BUTTON");
      return [];
    },
    querySelector(sel) {
      const attr = sel.startsWith("[") && sel.endsWith("]") ? sel.slice(1, -1) : null;
      if (!attr) return null;
      return findAttr(root, attr);
    },
    createElement: (tag) => makeEl(tag),
  };
  const windowMock = {
    location: { pathname },
    getComputedStyle: () => ({ backgroundColor: "" }),
  };
  const sandbox = {
    window: windowMock, document: doc, console,
    BroadcastChannel: FakeChannel,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    agentxThinkingChatId() {
      const parts = pathname.split("/");
      if (parts.length > 2 && parts[1] === "chat" && parts[2]) return parts[2];
      return null;
    },
  };
  vm.createContext(sandbox);
  assert(ruleSrc !== null, "rule source missing for the dynamic run");
  vm.runInContext(`var __rule = (${ruleSrc});`, sandbox);
  const run = () => vm.runInContext("__rule.run();", sandbox);
  const takeoverButtons = () =>
    collect(root, "BUTTON").filter((b) => b.attributes["data-agentx-takeover"] !== undefined);
  const fireTimers = () => { const ts = timers.splice(0); for (const fn of ts) fn(); };
  return { run, posted, banner, bannerWrap, interruptBtn, takeoverButtons, fireTimers, root };
}

{
  // Banner present: exactly one button, on the banner ROOT (full row),
  // label intact (no truncation — white-space:nowrap + root placement).
  const world = makeWorld({ pathname: "/chat/abc-123", withBanner: true });
  world.run();
  const btns = world.takeoverButtons();
  check("banner present: exactly one Take over sending button in the document",
    btns.length === 1 && btns[0].textContent === "Take over sending");
  check("the button sits on the banner root (not the narrow text div)",
    btns.length === 1 && btns[0].parentElement === world.bannerWrap);
  check("the button label cannot truncate (white-space:nowrap in its style)",
    btns.length === 1 &&
    (btns[0].style.cssText || "").indexOf("white-space:nowrap") !== -1);
  world.run();
  check("a second rule run creates no second button",
    world.takeoverButtons().length === 1);
  check("the dead Interrupt button is hidden while the banner is up",
    world.interruptBtn.style.display === "none" &&
    world.interruptBtn.getAttribute("data-agentx-interrupt-hidden") === "1");
  const btn = btns[0];
  btn.click();
  check("clicking Take over sending posts release-ownership with the chat id, once",
    world.posted.length === 1 &&
    world.posted[0].type === "release-ownership" &&
    world.posted[0].sessionId === "abc-123");
  check("after the click the button disables itself as Takeover requested…",
    btn.disabled === true && btn.textContent === "Takeover requested…");
  world.fireTimers();
  check("still queued after 15s: the button re-enables so the user can retry",
    btn.disabled === false && btn.textContent === "Take over sending");
}
{
  // TAKEOVER1 LIVE FAILURE, replayed: React re-renders replace the text
  // div on every run while the button survives. The old anchor-scoped
  // guard created one button per nested div (3x live); the document-wide
  // guard must keep exactly ONE button, the SAME node, on the banner root.
  const world = makeWorld({ pathname: "/chat/abc-123", withBanner: true });
  world.run();
  const first = world.takeoverButtons()[0];
  for (let round = 0; round < 3; round++) {
    const fresh = makeEl("div");
    fresh.textContent = "This tab queues only; sending is handled by another tab";
    world.bannerWrap.removeChild(world.bannerWrap.children.find((c) => c.tagName === "DIV" && c !== first));
    world.bannerWrap.appendChild(fresh);
    world.run();
    const btns = world.takeoverButtons();
    check(`re-render ${round + 1}: still exactly one takeover button in the document`,
      btns.length === 1);
    check(`re-render ${round + 1}: it is the SAME button node, on the banner root`,
      btns.length === 1 && btns[0] === first && btns[0].parentElement === world.bannerWrap);
  }
  check("clicking after re-renders still posts exactly once",
    (() => { world.takeoverButtons()[0].click(); return world.posted.length === 1; })());
}
{
  // A button stranded on an ancestor after the banner is gone is removed.
  const world = makeWorld({ pathname: "/chat/abc-123", withBanner: true });
  world.run();
  const btn = world.takeoverButtons()[0];
  world.root.appendChild(btn); // stranded on an ancestor, as live
  world.root.removeChild(world.bannerWrap); // the banner itself is gone
  world.run();
  check("banner gone: a stranded takeover button is removed from the document",
    world.takeoverButtons().length === 0);
  check("banner gone: the Interrupt button is restored",
    world.interruptBtn.style.display === "" &&
    world.interruptBtn.getAttribute("data-agentx-interrupt-hidden") === "0");
}
{
  // Clicked, then the banner disappears before the 15s retry: the timer
  // must NOT resurrect the button.
  const world = makeWorld({ pathname: "/chat/abc-123", withBanner: true });
  world.run();
  const btn = world.takeoverButtons()[0];
  btn.click();
  world.root.removeChild(world.bannerWrap);
  world.fireTimers();
  check("banner gone before the retry: the button stays disabled (no resurrection)",
    btn.disabled === true);
  world.run();
  check("banner gone before the retry: the stranded button is removed",
    world.takeoverButtons().length === 0);
}
{
  // No banner, no button; off-chat pages do nothing at all.
  const world = makeWorld({ pathname: "/chat/abc-123", withBanner: false });
  world.run();
  check("no banner: no takeover button is created and Interrupt stays visible",
    world.takeoverButtons().length === 0 &&
    world.interruptBtn.style.display !== "none");
  const settings = makeWorld({ pathname: "/settings/general", withBanner: true });
  settings.run();
  check("off-chat pages: the rule does nothing",
    settings.takeoverButtons().length === 0 &&
    settings.interruptBtn.style.display !== "none");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log("failed:", f);
  process.exit(1);
}
