// Reset page UI — /reset.
//
// Flow: pick categories -> Preview (POST /reset/api/preview) -> type DELETE +
// tick the checkbox -> Execute (POST /reset/api/execute). The execute button
// stays disabled until both, and the plan_id from the preview is echoed back,
// so a stale plan (files changed since preview) is refused with 409.
//
// Auth: the console session token is read from localStorage (same lookup the
// console's own injected scripts use) and sent as Authorization: Bearer.
// The Worker verifies it live against the console on every call.

(function () {
  "use strict";

  var CATEGORIES = [
    { id: "memories", label: "Memories", hint: "Erases the agent's long-term memory files." },
    { id: "skills", label: "Skills", hint: "Removes all workspace skills and the shared skill pool. Built-in skills are unaffected." },
    { id: "lessons", label: "Lessons", hint: "Clears the 'Important decisions and lessons' section of MEMORY.md." },
    { id: "models", label: "Models", hint: "Removes custom providers except the active one. The active model is never changed." },
    { id: "logs", label: "Logs", hint: "Deletes the QwenPaw log. The reset audit trail is never deleted." },
    { id: "sessions", label: "Sessions", hint: "Removes saved agent sessions and channel state." },
    { id: "chats", label: "Chats", hint: "Deletes ALL conversation history. Irreversible." },
    { id: "workspaces", label: "Workspaces", hint: "Removes workspace shell files (config, docs, screenshots). Does NOT touch memory, skills, chats or sessions." },
    { id: "backups", label: "Backups", hint: "Removes your only rollback copies." },
  ];

  var planId = null;
  var requestId = null;

  function el(id) { return document.getElementById(id); }
  function status(msg, cls) {
    var s = el("status");
    s.innerHTML = "";
    var d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = msg;
    s.appendChild(d);
  }

  function consoleToken() {
    try {
      var keys = ["qwenpaw_auth_token", "token", "qwenpaw_token", "qwenpaw-token", "access_token"];
      for (var i = 0; i < keys.length; i++) {
        var v = localStorage.getItem(keys[i]);
        if (v && v.length > 8) return v;
      }
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

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function selected() {
    var out = [];
    CATEGORIES.forEach(function (c) {
      var box = document.getElementById("cat-" + c.id);
      if (box && box.checked) out.push(c.id);
    });
    return out;
  }

  function renderCats() {
    var wrap = el("cats");
    CATEGORIES.forEach(function (c) {
      var div = document.createElement("div");
      div.className = "cat";
      div.id = "catwrap-" + c.id;
      var label = document.createElement("label");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.id = "cat-" + c.id;
      label.appendChild(box);
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = c.label;
      label.appendChild(name);
      div.appendChild(label);
      var hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = c.hint;
      div.appendChild(hint);
      var size = document.createElement("div");
      size.className = "size";
      size.id = "size-" + c.id;
      div.appendChild(size);
      var paths = document.createElement("div");
      paths.className = "paths";
      paths.id = "paths-" + c.id;
      div.appendChild(paths);
      wrap.appendChild(div);
    });
    // Lessons is a subset of Memories: ticking Memories force-ticks Lessons.
    var mem = document.getElementById("cat-memories");
    var les = document.getElementById("cat-lessons");
    mem.addEventListener("change", function () {
      if (mem.checked) { les.checked = true; les.disabled = true; }
      else { les.disabled = false; }
    });
  }

  async function api(path, body) {
    var token = consoleToken();
    if (!token) {
      el("signin").style.display = "block";
      throw new Error("not signed in");
    }
    var res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        "X-Request-Id": requestId || (requestId = uuid()),
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, data: data };
  }

  function syncExecute() {
    var ok = el("confirmText").value === "DELETE" && el("confirmAck").checked && !!planId;
    el("executeBtn").disabled = !ok;
  }

  async function doPreview() {
    var cats = selected();
    if (!cats.length) { status("Pick at least one category first.", "err"); return; }
    status("Previewing…");
    el("confirmBox").style.display = "none";
    planId = null;
    try {
      var r = await api("/reset/api/preview", { categories: cats });
    } catch (e) {
      status("Could not reach the console. Sign in and try again.", "err");
      return;
    }
    if (!r.ok) {
      var msg = (r.data && (r.data.detail || r.data.error)) || ("HTTP " + r.status);
      status("Preview failed: " + msg, "err");
      return;
    }
    var d = r.data;
    planId = d.plan_id;
    d.categories.forEach(function (c) {
      var size = document.getElementById("size-" + c.id);
      var paths = document.getElementById("paths-" + c.id);
      if (size) size.textContent = fmtBytes(c.bytes) + " · " + c.files + " file(s)";
      if (paths) paths.textContent = c.paths.slice(0, 12).join("\n") + (c.paths.length > 12 ? "\n… and " + (c.paths.length - 12) + " more" : "");
    });
    var total = "Total: " + fmtBytes(d.totals.bytes) + " · " + d.totals.files + " file(s) across " + d.categories.length + " categor(ies).";
    if (d.lessons_superseded) total += " Lessons is covered by Memories.";
    el("preview").textContent = "";
    status(total, "ok");
    el("confirmBox").style.display = "block";
    el("confirmText").value = "";
    el("confirmAck").checked = false;
    syncExecute();
  }

  async function doExecute() {
    var cats = selected();
    if (!planId) { status("Preview first — the plan changed or expired.", "err"); return; }
    el("executeBtn").disabled = true;
    status("Deleting…");
    var r;
    try {
      r = await api("/reset/api/execute", {
        categories: cats,
        confirm: "DELETE",
        ack: true,
        plan_id: planId,
      });
    } catch (e) {
      status("Could not reach the console.", "err");
      el("executeBtn").disabled = false;
      return;
    }
    if (!r.ok) {
      var msg = (r.data && (r.data.detail || r.data.error)) || ("HTTP " + r.status);
      if (r.status === 409 && r.data && r.data.error === "plan_changed") {
        msg = "The files changed since the preview. Preview again before deleting.";
      }
      status("Delete failed: " + msg, "err");
      el("executeBtn").disabled = false;
      return;
    }
    var d = r.data;
    var lines = ["Done. Status: " + d.status + ". Freed " + fmtBytes(d.totals.bytes_freed) + " (" + d.totals.files_deleted + " files)."];
    (d.per_category || []).forEach(function (c) {
      var line = "- " + c.id + ": " + c.status + ", freed " + fmtBytes(c.bytes_freed) + " (" + c.files_deleted + " files)";
      if (c.errors && c.errors.length) line += "; ERRORS: " + c.errors.map(function (e) { return e.path + ": " + e.error; }).join("; ");
      if (c.skipped && c.skipped.length) line += "; skipped: " + c.skipped.map(function (s) { return s.reason; }).join(", ");
      lines.push(line);
    });
    status(lines.join("\n"), d.status === "ok" ? "ok" : "err");
    planId = null;
    el("confirmBox").style.display = "none";
  }

  renderCats();
  el("previewBtn").addEventListener("click", doPreview);
  el("executeBtn").addEventListener("click", doExecute);
  el("confirmText").addEventListener("input", syncExecute);
  el("confirmAck").addEventListener("change", syncExecute);
  if (!consoleToken()) el("signin").style.display = "block";
})();
