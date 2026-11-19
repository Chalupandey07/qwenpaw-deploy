// T145 — multi-tab takeover (Step 10, 2026-11-19).
//
// Three parts, all machine-free:
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
check("the rule never removes React nodes (no removeChild/.remove()/innerHTML)",
  ruleSrc !== null &&
  !ruleSrc.includes("removeChild") && !ruleSrc.includes(".remove(") &&
  !ruleSrc.includes("innerHTML"));
check("the rule never polls (no setInterval/setTimeout)",
  ruleSrc !== null &&
  !ruleSrc.includes("setInterval") && !ruleSrc.includes("setTimeout"));
check("the rule is in the immediate-run list",
  workerJs.includes('agentxRunRuleNow("queue-takeover")'));
check("the Dockerfile builds FROM the live image, patches both copies, node --checks both",
  dockerfile.includes("FROM qwenpaw-agentx:2.3.0-approvalttl1") &&
  dockerfile.includes("apply-queue-takeover.py") &&
  dockerfile.includes("/app/src/qwenpaw/console/assets/index-DZrIuh3B.js") &&
  dockerfile.includes("/app/venv/lib/python3.11/site-packages/qwenpaw/console/assets/index-DZrIuh3B.js") &&
  dockerfile.includes("node --check"));

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

// ---- (c) dynamic checks: the rule in a DOM mock ----
// Minimal DOM: elements with children/parentElement, textContent,
// querySelector(All), createElement, addEventListener + click dispatch.
function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: null,
    attributes: {},
    style: {},
    textContent: "",
    disabled: false,
    listeners: {},
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
      return this.children.find((c) => c.attributes[attr] !== undefined) ?? null;
    },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    click() { for (const fn of this.listeners.click ?? []) fn.call(this); },
  };
  return el;
}
function makeWorld({ pathname, withBanner = true }) {
  const posted = [];
  class FakeChannel {
    constructor(name) { this.name = name; }
    postMessage(msg) { posted.push(msg); }
  }
  const root = makeEl("div");
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
  const allButtons = [interruptBtn];
  const collectDivs = (el, out = []) => {
    if (el.tagName === "DIV") out.push(el);
    for (const c of el.children) collectDivs(c, out);
    return out;
  };
  const doc = {
    body: makeEl("body"),
    querySelectorAll(sel) {
      // Live walk from the root: a removed banner stops being found,
      // as in a real DOM (a static list would keep finding it).
      if (sel === "div") return collectDivs(root);
      if (sel === "button") return allButtons;
      return [];
    },
    querySelector() { return null; },
    createElement: (tag) => makeEl(tag),
  };
  const windowMock = {
    location: { pathname },
    getComputedStyle: () => ({ backgroundColor: "" }),
  };
  const sandbox = {
    window: windowMock, document: doc, console,
    BroadcastChannel: FakeChannel,
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
  const takeoverBtn = () => banner.querySelector("[data-agentx-takeover]");
  return { run, posted, banner, bannerWrap, interruptBtn, takeoverBtn, root };
}

{
  const world = makeWorld({ pathname: "/chat/abc-123", withBanner: true });
  world.run();
  const btn = world.takeoverBtn();
  check("banner present: exactly one Take over sending button is appended to the banner",
    btn !== null && btn.textContent === "Take over sending" &&
    btn.parentElement === world.banner);
  world.run();
  check("a second rule run creates no second button",
    world.banner.children.filter((c) => c.attributes["data-agentx-takeover"]).length === 1);
  check("the dead Interrupt button is hidden while the banner is up",
    world.interruptBtn.style.display === "none" &&
    world.interruptBtn.getAttribute("data-agentx-interrupt-hidden") === "1");
  btn.click();
  check("clicking Take over sending posts release-ownership with the chat id",
    world.posted.length === 1 &&
    world.posted[0].type === "release-ownership" &&
    world.posted[0].sessionId === "abc-123");
  check("after the click the button disables itself as Takeover requested…",
    btn.disabled === true && btn.textContent === "Takeover requested…");
}
{
  // The tab becomes the owner (banner gone): the Interrupt button comes back.
  const world = makeWorld({ pathname: "/chat/abc-123", withBanner: true });
  world.run();
  world.bannerWrap.removeChild(world.banner);
  world.run();
  check("banner gone: the Interrupt button is restored",
    world.interruptBtn.style.display === "" &&
    world.interruptBtn.getAttribute("data-agentx-interrupt-hidden") === "0");
}
{
  // No banner, no button; off-chat pages do nothing at all.
  const world = makeWorld({ pathname: "/chat/abc-123", withBanner: false });
  world.run();
  check("no banner: no takeover button is created and Interrupt stays visible",
    world.takeoverBtn() === null &&
    world.interruptBtn.style.display !== "none");
  const settings = makeWorld({ pathname: "/settings/general", withBanner: true });
  settings.run();
  check("off-chat pages: the rule does nothing",
    settings.takeoverBtn() === null &&
    settings.interruptBtn.style.display !== "none");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log("failed:", f);
  process.exit(1);
}
