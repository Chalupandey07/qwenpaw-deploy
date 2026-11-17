// Vault page logic.
//
// The page is static bytes; every endpoint it calls is gated by the vault
// router's requiresSession(). ensureSession() runs first (same pattern as
// /computer, B-39: the token key the console ACTUALLY uses is
// qwenpaw_auth_token).
//
// The reveal dialog is transient by design: the value is held in a single
// local variable, never in page state, never in localStorage, and is wiped
// when the dialog closes or the page loses focus.

let sessionState = "unknown"; // unknown | ok | needed
let items = [];
let revealValue = "";

function consoleToken() {
  try {
    const keys = ["qwenpaw_auth_token", "token", "qwenpaw_token", "qwenpaw-token", "access_token"];
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v && v.length > 8) return v;
    }
    for (let j = 0; j < localStorage.length; j += 1) {
      const raw = localStorage.getItem(localStorage.key(j));
      if (!raw || raw.length < 8) continue;
      try {
        const o = JSON.parse(raw);
        if (o && typeof o === "object") {
          const t = o.token || o.access_token || o.accessToken;
          if (typeof t === "string" && t.length > 8) return t;
        }
      } catch { /* not JSON */ }
    }
  } catch { /* storage blocked */ }
  return "";
}

async function ensureSession() {
  try {
    const already = await fetch("/api/session/state", { cache: "no-store", credentials: "same-origin" });
    const st = await already.json().catch(() => ({}));
    if (st && st.ok) { sessionState = "ok"; return true; }
  } catch { /* fall through to mint */ }
  const token = consoleToken();
  if (!token) { sessionState = "needed"; return false; }
  const res = await fetch("/api/session/mint", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (res.ok) { sessionState = "ok"; return true; }
  sessionState = "needed";
  return false;
}

async function api(path, body, method) {
  const doFetch = () => fetch(path, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  let res = await doFetch();
  if (res.status === 401) {
    const ok = await ensureSession();
    if (ok) res = await doFetch();
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Reveal needs the console bearer token as well as the session cookie
// (the router verifies it against /api/cron/jobs). Send it here.
async function revealApi(name) {
  const token = consoleToken();
  const res = await fetch("/vault/reveal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({ name }),
    credentials: "same-origin",
    cache: "no-store",
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok === false ? "err" : ok === true ? "ok" : "meta";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function filtered() {
  const q = $("search").value.trim().toLowerCase();
  const k = $("kindFilter").value;
  return items.filter((it) => {
    if (k && it.kind !== k) return false;
    if (q && !(it.name.toLowerCase().includes(q) || (it.title || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

function render() {
  const list = $("list");
  const rows = filtered();
  if (!rows.length) {
    list.innerHTML = `<p class="hint">No keys yet. Add one above — the agent can use it without ever seeing the value.</p>`;
    return;
  }
  list.innerHTML = rows.map((it) => `
    <div class="card" data-name="${esc(it.name)}">
      <h3>${esc(it.name)} <span class="tag">${esc(it.kind)}</span>${it.policy === "off" ? '<span class="tag off">off</span>' : ""}</h3>
      <div class="meta">${esc(it.title || "")}</div>
      <div class="meta">${it.origin ? `Origin: ${esc(it.origin)}` : "Variable — exported as $" + esc(it.name.toUpperCase().replace(/-/g, "_"))}</div>
      ${it.note ? `<div class="meta">${esc(it.note)}</div>` : ""}
      <div class="row" style="margin-top:8px">
        <button type="button" data-act="show">Show</button>
        <button type="button" class="secondary" data-act="activity">Activity</button>
        <button type="button" class="secondary" data-act="edit">Edit</button>
        <button type="button" class="danger" data-act="remove">Remove</button>
      </div>
      <div class="meta activity" hidden></div>
    </div>`).join("");
}

async function load() {
  const r = await api("/vault/list");
  if (!r.ok) {
    setStatus(`Could not load the vault (${r.status}).`, false);
    return;
  }
  items = (r.data && r.data.items) || [];
  setStatus(`${items.length} key${items.length === 1 ? "" : "s"} stored.`, true);
  render();
}

function openReveal(name, value) {
  revealValue = value;
  $("revealTitle").textContent = `Key value — ${name}`;
  $("revealValue").textContent = value;
  $("revealDialog").classList.add("open");
}

function closeReveal() {
  revealValue = "";
  $("revealValue").textContent = "";
  $("revealDialog").classList.remove("open");
}

async function showItem(name) {
  const r = await revealApi(name);
  if (!r.ok) {
    setStatus(`Could not reveal ${name} (${r.status}${r.data && r.data.error ? `: ${r.data.error}` : ""}).`, false);
    return;
  }
  openReveal(name, r.data.value);
}

async function showActivity(card, name) {
  const box = card.querySelector(".activity");
  if (!box.hidden) { box.hidden = true; return; }
  const r = await api(`/vault/activity?name=${encodeURIComponent(name)}`);
  if (!r.ok) {
    box.textContent = `Could not load activity (${r.status}).`;
    box.hidden = false;
    return;
  }
  const uses = (r.data && r.data.uses) || [];
  box.innerHTML = uses.length
    ? uses.map((u) => `<div>${esc(new Date(u.createdAt).toLocaleString())} — ${esc(u.tool)}${u.site ? ` — ${esc(u.site)}` : ""}</div>`).join("")
    : "No uses recorded yet.";
  box.hidden = false;
}

function fillForm(it) {
  $("fName").value = it.name;
  $("fKind").value = it.kind;
  $("fOrigin").value = it.origin || "";
  $("fHeader").value = "";
  $("fUser").value = "";
  $("fTitle").value = it.title || "";
  $("fNote").value = it.note || "";
  $("fValue").value = "";
  $("fValue").placeholder = "Leave blank to keep the current value";
  $("fValue").required = false;
  syncKindFields();
  $("addForm").classList.add("open");
  $("addForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function syncKindFields() {
  const kind = $("fKind").value;
  $("originLabel").hidden = kind === "command";
  $("headerLabel").hidden = kind !== "header";
  $("userLabel").hidden = kind !== "basic";
  $("fOrigin").required = kind !== "command";
}

async function submitForm(e) {
  e.preventDefault();
  const err = $("addErr");
  err.textContent = "";
  const name = $("fName").value.trim();
  const kind = $("fKind").value;
  const value = $("fValue").value;
  const isEdit = items.some((it) => it.name === name);
  if (isEdit && !value) {
    err.textContent = "Editing needs a value — re-enter the key to change it, or cancel to keep it.";
    return;
  }
  const body = {
    name, kind,
    origin: kind === "command" ? undefined : $("fOrigin").value.trim(),
    headerName: kind === "header" ? $("fHeader").value.trim() : undefined,
    username: kind === "basic" ? $("fUser").value.trim() : undefined,
    value,
    title: $("fTitle").value.trim(),
    note: $("fNote").value.trim(),
  };
  const r = await api("/vault/put", body);
  if (!r.ok) {
    err.textContent = `Could not save (${r.status}${r.data && r.data.error ? `: ${r.data.error}` : ""}${r.data && r.data.detail ? ` — ${r.data.detail}` : ""}).`;
    return;
  }
  $("addForm").classList.remove("open");
  $("addForm").reset();
  $("fValue").required = true;
  $("fValue").placeholder = "Paste the key here — it is sealed on the server, never shown again";
  setStatus(`Saved ${name}.`, true);
  await load();
}

async function boot() {
  const ok = await ensureSession();
  if (!ok) {
    $("sessionNote").hidden = false;
    return;
  }
  $("app").hidden = false;
  await load();

  $("search").addEventListener("input", render);
  $("kindFilter").addEventListener("change", render);
  $("addBtn").addEventListener("click", () => {
    $("addForm").reset();
    $("fValue").required = true;
    $("addErr").textContent = "";
    syncKindFields();
    $("addForm").classList.toggle("open");
  });
  $("cancelAdd").addEventListener("click", () => $("addForm").classList.remove("open"));
  $("fKind").addEventListener("change", syncKindFields);
  $("addForm").addEventListener("submit", submitForm);
  syncKindFields();

  $("list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const card = e.target.closest(".card");
    const name = card && card.dataset.name;
    if (!name) return;
    if (btn.dataset.act === "show") await showItem(name);
    else if (btn.dataset.act === "activity") await showActivity(card, name);
    else if (btn.dataset.act === "edit") {
      const it = items.find((x) => x.name === name);
      if (it) fillForm(it);
    } else if (btn.dataset.act === "remove") {
      if (!confirm(`Remove ${name} from the vault? This cannot be undone.`)) return;
      const r = await api("/vault/remove", { name });
      if (!r.ok) setStatus(`Could not remove ${name} (${r.status}).`, false);
      else { setStatus(`Removed ${name}.`, true); await load(); }
    }
  });

  $("revealClose").addEventListener("click", closeReveal);
  $("revealDialog").addEventListener("click", (e) => {
    if (e.target === $("revealDialog")) closeReveal();
  });
  $("revealCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(revealValue);
      setStatus("Copied to the clipboard.", true);
    } catch {
      setStatus("Could not copy — select the value and copy it by hand.", false);
    }
  });
  // The value disappears when the page loses focus: it is transient by design.
  window.addEventListener("blur", closeReveal);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) closeReveal();
  });
}

boot();
