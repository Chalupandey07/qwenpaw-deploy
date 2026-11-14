// qwenpaw-board — tiny ticket board for QwenPaw (Cloudflare Worker + KV).
// Free-tier safe: one KV key ("tickets") holds the whole board as JSON.
// No external resources, no build step, English only.
//
// Auth: every /api/* call needs the shared board key, either as
// ?key=... or header X-Board-Key. The key lives in the Worker secret
// BOARD_TOKEN (set with the Cloudflare API, never in git). The HTML page
// itself is public; it asks for the key once and keeps it in localStorage.
//
// Columns (Rakazo parity): todo / in-progress / in-review / blocked /
// done / wont-do ("Won't do").
//
// API:
//   GET    /api/tickets            list all tickets
//   POST   /api/tickets            {title, description?, agent?, priority?, follow_up?}
//   GET    /api/tickets/:id
//   PATCH  /api/tickets/:id        {title?, description?, column?, agent?, priority?, follow_up?}
//   DELETE /api/tickets/:id
//   POST   /api/tickets/:id/comments   {text} — append a comment (Rakazo parity)
//   POST   /api/tickets/:id/mark-sent — record that the ticket was posted
//          to QwenPaw: sets qwenpaw_session + sent_to_qwenpaw_at, and moves
//          a To-do ticket to In progress.
//   GET    /api/tickets/:id/qwenpaw-task   {task_text, curl, api_url, note, sent}
//   GET    /health
//
// KV note: Cloudflare KV is eventually consistent. A mutation response
// already carries the authoritative ticket, so the UI updates from the
// response and only re-fetches in the background a few seconds later.

export const COLUMNS = [
  { id: "todo", label: "To do" },
  { id: "in-progress", label: "In progress" },
  { id: "in-review", label: "In review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
  { id: "wont-do", label: "Won't do" },
];

const AGENTS = ["default", "QwenPaw_QA_Agent_0.2"];
const PRIORITIES = ["low", "normal", "high"];
const KV_KEY = "tickets";
const MAX_COMMENTS = 50;
const MAX_COMMENT_LEN = 1000;

// Public console URL (Cloudflare Pages proxy in front of QwenPaw).
const CONSOLE_URL = "https://qwenpawx.pages.dev";
const CONSOLE_CHAT_API = CONSOLE_URL + "/api/console/chat";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authed(request, env) {
  if (!env.BOARD_TOKEN) return false;
  const url = new URL(request.url);
  const key = request.headers.get("x-board-key") || url.searchParams.get("key") || "";
  return safeEqual(key, env.BOARD_TOKEN);
}

async function loadTickets(env) {
  const raw = await env.TICKETS.get(KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.tickets || [];
  } catch {
    return [];
  }
}

async function saveTickets(env, tickets) {
  await env.TICKETS.put(KV_KEY, JSON.stringify({ tickets, updated_at: new Date().toISOString() }));
}

function cleanTicket(t) {
  return {
    id: t.id,
    title: t.title,
    description: t.description || "",
    column: t.column,
    agent: t.agent,
    priority: t.priority,
    follow_up: !!t.follow_up,
    comments: Array.isArray(t.comments) ? t.comments : [],
    qwenpaw_session: t.qwenpaw_session || null,
    sent_to_qwenpaw_at: t.sent_to_qwenpaw_at || null,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function validatePatch(body) {
  const out = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200)
      return { error: "title must be a non-empty string up to 200 chars" };
    out.title = body.title.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > 5000)
      return { error: "description must be a string up to 5000 chars" };
    out.description = body.description;
  }
  if (body.column !== undefined) {
    if (!COLUMNS.some((c) => c.id === body.column)) return { error: "unknown column" };
    out.column = body.column;
  }
  if (body.agent !== undefined) {
    if (!AGENTS.includes(body.agent)) return { error: "unknown agent" };
    out.agent = body.agent;
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) return { error: "unknown priority" };
    out.priority = body.priority;
  }
  if (body.follow_up !== undefined) out.follow_up = !!body.follow_up;
  return { value: out };
}

function taskText(t) {
  const lines = [
    `[Ticket ${t.id.slice(0, 8)}] ${t.title}`,
    `Agent: ${t.agent}`,
    `Priority: ${t.priority}`,
    `Board column: ${COLUMNS.find((c) => c.id === t.column)?.label || t.column}`,
  ];
  if (t.description) lines.push("", t.description);
  if (Array.isArray(t.comments) && t.comments.length) {
    lines.push("", "Comments:");
    for (const c of t.comments) lines.push(`- ${c.text}`);
  }
  lines.push("", "Source: QwenPaw ticket board (qwenpaw-board)");
  return lines.join("\n");
}

function qwenpawTask(t) {
  const text = taskText(t);
  const sessionId = `board-${t.id.slice(0, 8)}`;
  const body = {
    channel: "console",
    user_id: "default",
    session_id: sessionId,
    input: [{ content: [{ type: "text", text }] }],
  };
  return {
    ticket_id: t.id,
    session_id: sessionId,
    sent: !!t.sent_to_qwenpaw_at,
    sent_to_qwenpaw_at: t.sent_to_qwenpaw_at || null,
    task_text: text,
    api_url: CONSOLE_CHAT_API,
    method: "POST",
    body,
    curl:
      `curl -X POST ${CONSOLE_CHAT_API} \\\n` +
      `  -H 'Content-Type: application/json' \\\n` +
      `  -b '<your logged-in console session cookie>' \\\n` +
      `  -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`,
    note:
      "Posting a ticket to QwenPaw uses POST /api/console/chat (Agent API Request Format). " +
      "It requires a logged-in console session, so the board cannot post it server-side: " +
      "copy the task text and paste it into the QwenPaw console chat, or run the curl above " +
      "from a browser session that is already logged in. The run continues in the background " +
      "after disconnect; stop it with POST /api/console/chat/stop?chat_id=<chat id>. " +
      "The ticket's session_id is board-<first 8 chars of ticket id>, so the work lands in " +
      "one traceable console session per ticket. After posting, use POST " +
      "/api/tickets/:id/mark-sent (or the 'Mark as sent' button) so the board records it.",
  };
}

const BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QwenPaw Ticket Board</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
header{padding:14px 18px;background:#1e293b;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:18px;margin:0}
header p{margin:0;color:#94a3b8;font-size:13px}
#keybar{margin-left:auto;display:flex;gap:6px}
input,select,textarea,button{font:inherit;color:#0f172a;border-radius:6px;border:1px solid #475569;padding:6px 8px}
button{background:#38bdf8;border-color:#38bdf8;cursor:pointer}
button.ghost{background:transparent;color:#e2e8f0;border-color:#475569}
main{padding:14px 18px}
#newticket{background:#1e293b;padding:12px;border-radius:8px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#newticket input[type=text]{flex:2;min-width:220px}
#newticket textarea{flex:3;min-width:220px}
#board{display:grid;grid-template-columns:repeat(6,minmax(200px,1fr));gap:10px;overflow-x:auto}
.col{background:#1e293b;border-radius:8px;padding:8px;min-height:200px}
.col h2{font-size:14px;margin:4px 2px 10px;color:#f8fafc}
.card{background:#334155;border-radius:6px;padding:8px;margin-bottom:8px}
.card h3{font-size:14px;margin:0 0 4px}
.card p{font-size:13px;margin:0 0 6px;color:#cbd5e1;white-space:pre-wrap;word-break:break-word}
.meta{font-size:11px;color:#94a3b8;margin-bottom:6px}
.sent{font-size:11px;color:#4ade80;margin-bottom:6px}
.card .row{display:flex;gap:4px;flex-wrap:wrap}
.card .row button{font-size:12px;padding:3px 6px}
.card .row select{font-size:12px;padding:3px}
.follow{color:#fbbf24}
#error{color:#f87171;margin:8px 0}
.comments{font-size:12px;color:#cbd5e1;margin:6px 0}
.comments li{margin-bottom:3px}
.comments input{font-size:12px;width:70%}
footer{padding:10px 18px;color:#64748b;font-size:12px}
a{color:#38bdf8}
code{background:#0f172a;padding:1px 4px;border-radius:4px}
#taskbox{background:#1e293b;border-radius:8px;padding:12px;margin-top:14px;display:none}
#taskbox pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;padding:10px;border-radius:6px;font-size:12px}
</style>
</head>
<body>
<header>
  <h1>QwenPaw Ticket Board</h1>
  <p>Columns: To do / In progress / In review / Blocked / Done / Won't do &middot; stored in Cloudflare KV</p>
  <span id="keybar">
    <input type="password" id="key" placeholder="Board key" size="18">
    <button id="savekey">Use key</button>
  </span>
</header>
<main>
  <div id="error"></div>
  <form id="newticket">
    <input type="text" id="title" placeholder="Ticket title" maxlength="200" required>
    <textarea id="desc" placeholder="Description (optional)" rows="1"></textarea>
    <select id="agent"><option value="default">default agent</option><option value="QwenPaw_QA_Agent_0.2">QA Agent</option></select>
    <select id="prio"><option value="normal">normal</option><option value="low">low</option><option value="high">high</option></select>
    <label><input type="checkbox" id="followup"> follow-up</label>
    <button type="submit">Create ticket</button>
  </form>
  <div id="board"></div>
  <div id="taskbox">
    <h2 style="font-size:15px;margin:0 0 6px">Post to QwenPaw</h2>
    <p style="font-size:13px;color:#94a3b8">The board cannot post this itself (QwenPaw needs your logged-in console session). Copy the text below into the console chat at <a href="https://qwenpawx.pages.dev" target="_blank" rel="noopener">qwenpawx.pages.dev</a>, or run the curl from a logged-in browser session. One ticket = one console session (<code>board-&lt;ticket id&gt;</code>). After posting, press "Mark as sent" on the ticket so the board records it.</p>
    <pre id="tasktext"></pre>
    <pre id="taskcurl"></pre>
    <button id="copytask">Copy task text</button>
    <button id="copycurl">Copy curl</button>
  </div>
</main>
<footer>Worker: qwenpaw-board &middot; Console: <a href="https://qwenpawx.pages.dev">qwenpawx.pages.dev</a> &middot; Open work &amp; cost pages live in the qwenpaw-deploy repo under features/board/.</footer>
<script>
const COLUMNS = ${JSON.stringify(COLUMNS)};
let KEY = localStorage.getItem("qwenpaw-board-key") || "";
let TICKETS = [];
const $ = (id) => document.getElementById(id);
const err = (m) => { $("error").textContent = m || ""; };
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function api(path, opts={}){
  opts.headers = Object.assign({}, opts.headers||{}, {"x-board-key": KEY, "content-type":"application/json"});
  return fetch(path, opts).then(async r=>{ const t = await r.text(); let d; try{ d=JSON.parse(t);}catch{ d={error:t}; } if(!r.ok) throw new Error(d.error||("HTTP "+r.status)); return d; });
}
// KV is eventually consistent: trust the mutation response immediately and
// only re-fetch in the background a few seconds later to converge.
function refreshSoon(){ setTimeout(()=>load(true), 4000); }
async function load(quiet){
  if(!quiet) err("");
  try{
    TICKETS = await api("/api/tickets");
    render();
  }catch(e){ if(!quiet) err("Could not load tickets: "+e.message+" — enter the board key above."); render(); }
}
function render(){
  const board = $("board"); board.innerHTML = "";
  for(const col of COLUMNS){
    const div = document.createElement("div"); div.className="col";
    div.innerHTML = "<h2>"+esc(col.label)+" ("+TICKETS.filter(t=>t.column===col.id).length+")</h2>";
    for(const t of TICKETS.filter(t=>t.column===col.id)){
      const card = document.createElement("div"); card.className="card";
      card.innerHTML = "<h3>"+esc(t.title)+(t.follow_up?' <span class="follow" title="follow-up">★ follow-up</span>':'')+"</h3>"
        + (t.description ? "<p>"+esc(t.description)+"</p>" : "")
        + '<div class="meta">'+esc(t.agent)+' · '+esc(t.priority)+' · '+esc(t.id.slice(0,8))+' · '+esc((t.created_at||"").slice(0,10))+'</div>'
        + (t.sent_to_qwenpaw_at ? '<div class="sent">Sent to QwenPaw ' + esc(t.sent_to_qwenpaw_at.slice(0,16).replace("T"," ")) + ' · session <code>'+esc(t.qwenpaw_session||"")+'</code></div>' : "");
      const comments = t.comments || [];
      if(comments.length){
        const ul = document.createElement("ul"); ul.className="comments";
        for(const c of comments){ const li=document.createElement("li"); li.textContent=(c.at||"").slice(0,16).replace("T"," ")+" — "+c.text; ul.appendChild(li); }
        card.appendChild(ul);
      }
      const crow = document.createElement("div"); crow.className="row";
      const cinput = document.createElement("input"); cinput.type="text"; cinput.placeholder="Add a comment"; cinput.maxLength=1000;
      const cbtn = document.createElement("button"); cbtn.textContent="Comment"; cbtn.className="ghost";
      cbtn.onclick = async ()=>{ const text=cinput.value.trim(); if(!text) return; try{ const upd = await api("/api/tickets/"+t.id+"/comments",{method:"POST",body:JSON.stringify({text})}); TICKETS = TICKETS.map(x=>x.id===t.id?upd:x); render(); refreshSoon(); }catch(e){ err(e.message); } };
      crow.appendChild(cinput); crow.appendChild(cbtn);
      card.appendChild(crow);
      const row = document.createElement("div"); row.className="row";
      const sel = document.createElement("select");
      for(const c of COLUMNS){ const o=document.createElement("option"); o.value=c.id; o.textContent="→ "+c.label; if(c.id===t.column) o.selected=true; sel.appendChild(o); }
      sel.onchange = async ()=>{ try{ const upd = await api("/api/tickets/"+t.id,{method:"PATCH",body:JSON.stringify({column:sel.value})}); TICKETS = TICKETS.map(x=>x.id===t.id?upd:x); render(); refreshSoon(); }catch(e){ err(e.message); } };
      row.appendChild(sel);
      const toQ = document.createElement("button"); toQ.textContent="Post to QwenPaw"; toQ.className="ghost";
      toQ.onclick = async ()=>{ try{ const d = await api("/api/tickets/"+t.id+"/qwenpaw-task"); $("tasktext").textContent=d.task_text; $("taskcurl").textContent=d.curl; $("taskbox").style.display="block"; $("taskbox").scrollIntoView(); }catch(e){ err(e.message); } };
      row.appendChild(toQ);
      if(!t.sent_to_qwenpaw_at){
        const sent = document.createElement("button"); sent.textContent="Mark as sent"; sent.className="ghost";
        sent.onclick = async ()=>{ try{ const upd = await api("/api/tickets/"+t.id+"/mark-sent",{method:"POST"}); TICKETS = TICKETS.map(x=>x.id===t.id?upd:x); render(); refreshSoon(); }catch(e){ err(e.message); } };
        row.appendChild(sent);
      }
      const del = document.createElement("button"); del.textContent="Delete"; del.className="ghost";
      del.onclick = async ()=>{ if(!confirm("Delete ticket '"+t.title+"'?")) return; try{ await api("/api/tickets/"+t.id,{method:"DELETE"}); TICKETS = TICKETS.filter(x=>x.id!==t.id); render(); refreshSoon(); }catch(e){ err(e.message); } };
      row.appendChild(del);
      card.appendChild(row);
      div.appendChild(card);
    }
    board.appendChild(div);
  }
}
$("savekey").onclick = ()=>{ KEY = $("key").value.trim(); localStorage.setItem("qwenpaw-board-key", KEY); load(); };
if(KEY) $("key").value = KEY;
$("newticket").onsubmit = async (e)=>{
  e.preventDefault(); err("");
  const body = { title: $("title").value.trim(), description: $("desc").value, agent: $("agent").value, priority: $("prio").value, follow_up: $("followup").checked };
  try{ const created = await api("/api/tickets",{method:"POST",body:JSON.stringify(body)}); TICKETS.push(created); render(); $("title").value=""; $("desc").value=""; $("followup").checked=false; refreshSoon(); }
  catch(ex){ err("Create failed: "+ex.message); }
};
$("copytask").onclick = ()=>{ navigator.clipboard.writeText($("tasktext").textContent).then(()=>{ $("copytask").textContent="Copied!"; setTimeout(()=>$("copytask").textContent="Copy task text",1500); }); };
$("copycurl").onclick = ()=>{ navigator.clipboard.writeText($("taskcurl").textContent).then(()=>{ $("copycurl").textContent="Copied!"; setTimeout(()=>$("copycurl").textContent="Copy curl",1500); }); };
load();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return json({ ok: true, worker: "qwenpaw-board" });
    if (path === "/" || path === "/index.html") {
      return new Response(BOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (!path.startsWith("/api/")) return json({ error: "not found" }, 404);
    if (!authed(request, env)) {
      return json(
        { error: "unauthorized — send the board key as ?key= or X-Board-Key header" },
        401,
      );
    }

    const parts = path.split("/").filter(Boolean); // ["api","tickets", id?, action?]

    try {
      if (parts[1] === "tickets" && parts.length === 2) {
        if (request.method === "GET") {
          const tickets = await loadTickets(env);
          return json(tickets.map(cleanTicket));
        }
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const v = validatePatch(body);
          if (v.error) return json({ error: v.error }, 400);
          if (!v.value.title) return json({ error: "title is required" }, 400);
          const now = new Date().toISOString();
          const ticket = {
            id: crypto.randomUUID(),
            title: v.value.title,
            description: v.value.description || "",
            column: "todo",
            agent: v.value.agent || "default",
            priority: v.value.priority || "normal",
            follow_up: !!v.value.follow_up,
            comments: [],
            qwenpaw_session: null,
            sent_to_qwenpaw_at: null,
            created_at: now,
            updated_at: now,
          };
          const tickets = await loadTickets(env);
          tickets.push(ticket);
          await saveTickets(env, tickets);
          return json(cleanTicket(ticket), 201);
        }
        return json({ error: "method not allowed" }, 405);
      }

      if (parts[1] === "tickets" && parts.length >= 3) {
        const id = decodeURIComponent(parts[2]);
        const tickets = await loadTickets(env);
        const idx = tickets.findIndex((t) => t.id === id);
        if (idx === -1) return json({ error: "ticket not found" }, 404);
        const ticket = tickets[idx];

        if (parts.length === 4 && parts[3] === "qwenpaw-task") {
          if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
          return json(qwenpawTask(ticket));
        }
        if (parts.length === 4 && parts[3] === "comments") {
          if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
          const body = await request.json().catch(() => ({}));
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text || text.length > MAX_COMMENT_LEN)
            return json({ error: "comment text must be 1-1000 chars" }, 400);
          ticket.comments = Array.isArray(ticket.comments) ? ticket.comments : [];
          if (ticket.comments.length >= MAX_COMMENTS)
            return json({ error: "too many comments (max 50)" }, 400);
          ticket.comments.push({ at: new Date().toISOString(), text });
          ticket.updated_at = new Date().toISOString();
          await saveTickets(env, tickets);
          return json(cleanTicket(ticket));
        }
        if (parts.length === 4 && parts[3] === "mark-sent") {
          if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
          const now = new Date().toISOString();
          ticket.qwenpaw_session = `board-${ticket.id.slice(0, 8)}`;
          ticket.sent_to_qwenpaw_at = now;
          if (ticket.column === "todo") ticket.column = "in-progress";
          ticket.updated_at = now;
          await saveTickets(env, tickets);
          return json(cleanTicket(ticket));
        }
        if (parts.length !== 3) return json({ error: "not found" }, 404);

        if (request.method === "GET") return json(cleanTicket(ticket));
        if (request.method === "PATCH") {
          const body = await request.json().catch(() => ({}));
          const v = validatePatch(body);
          if (v.error) return json({ error: v.error }, 400);
          Object.assign(ticket, v.value, { updated_at: new Date().toISOString() });
          await saveTickets(env, tickets);
          return json(cleanTicket(ticket));
        }
        if (request.method === "DELETE") {
          tickets.splice(idx, 1);
          await saveTickets(env, tickets);
          return json({ deleted: true, id });
        }
        return json({ error: "method not allowed" }, 405);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "server error: " + (e?.message || e) }, 500);
    }
  },
};
