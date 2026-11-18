#!/usr/bin/env python3
"""Telegram menu protocol for QwenPaw (features/telegram-full/).

Pure stdlib. This is the single source for the menu tree, the
callback_data grammar, and the per-chat token cache. The derived-image
patch ships a byte-identical copy as
``qwenpaw_channel_telegram/cards/menu.py`` (see
``src/patched/cards/menu.py`` and the T131 test, which enforces the
identity) so the driver and the CLI can never drift apart.

Callback grammar (Telegram limit: callback_data <= 64 bytes):
  ``ns:verb[:arg...]`` where ns is ``ui`` (navigation — any allowlisted
  user) or ``act`` (a mutation — owner only). Namespaces and verbs are
  lowercase ASCII; arguments may be uppercase (approval levels are
  SMART, JEV, …). ``tga:`` / ``tgd:`` are
  reserved for the upstream approval cards and are never emitted here.
  Arguments that are long or unstable (provider+model pairs, skill
  names) go through the per-chat token cache instead of the payload
  (a UUID plus a 4-char prefix is 41 bytes and fits, so chat-open
  uses the UUID directly).

Verbs:
  ui:m:<menu>   open a menu (root, set, appr, mem, board, vault, comp,
                cost, chan, chats, model, skills, jobs)
  ui:n:new      start a new chat (upstream /new path)
  ui:o:<uuid>   open an existing console chat (preview + continue)
  ui:p:<n>      page n of the current list
  ui:l:<token>  select a cached list entry (model / provider)
  ui:a:<action> a read-only action (memsearch, memhandoff, boardlist,
                vaultlist, compstatus, costshow, vaultreveal)
  ui:x          close (delete the keyboard)
  act:ap:<LEVEL> set the approval level (STRICT/SMART/AUTO/OFF/JEV)
  act:md:<provider>:<model> set the active model (validated first)
  act:ch:<toggle> flip a channel behaviour toggle (mention/typing/
                tools/think/stream)
  act:g:rest    Rest the machine (POST /api/machine/sleep)
  act:j:<token> toggle a job (cached job id)
  act:s:<token> enable/disable a skill (cached skill name)
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

CALLBACK_MAX_BYTES = 64
CALLBACK_RE = re.compile(r"^(ui|act):[A-Za-z0-9:_./-]{1,60}$")
RESERVED_PREFIXES = ("tga:", "tgd:")
CACHE_TTL_SECONDS = 15 * 60
CACHE_MAX_ENTRIES = 200
LABEL_MAX_CHARS = 40
TEXT_MAX_CHARS = 3800

_BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def valid_callback(data: str) -> bool:
    """True if data is a well-formed menu callback (and not reserved)."""
    if not isinstance(data, str) or not data:
        return False
    if data.startswith(RESERVED_PREFIXES):
        return False
    if len(data.encode("utf-8")) > CALLBACK_MAX_BYTES:
        return False
    return CALLBACK_RE.match(data) is not None


def parse_callback(data: str):
    """Parse a callback into {ns, verb, arg, raw} or None if invalid."""
    if not valid_callback(data):
        return None
    parts = data.split(":")
    return {
        "ns": parts[0],
        "verb": parts[1] if len(parts) > 1 else "",
        "arg": ":".join(parts[2:]) if len(parts) > 2 else "",
        "raw": data,
    }


def truncate_label(text: str, n: int = LABEL_MAX_CHARS) -> str:
    """Shorten a button label; Telegram buttons are small."""
    text = (text or "").strip().replace("\n", " ")
    if len(text) <= n:
        return text
    return text[: n - 1].rstrip() + "…"


def split_text(text: str, limit: int = TEXT_MAX_CHARS) -> list[str]:
    """Split outbound text on paragraph boundaries (hard-split a lone
    over-long paragraph). Every chunk is <= limit."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    current = ""
    for para in text.split("\n\n"):
        if len(para) > limit:
            if current:
                chunks.append(current)
                current = ""
            for i in range(0, len(para), limit):
                chunks.append(para[i:i + limit])
            continue
        if current and len(current) + 2 + len(para) > limit:
            chunks.append(current)
            current = para
        else:
            current = current + "\n\n" + para if current else para
    if current:
        chunks.append(current)
    return chunks


# ---------------------------------------------------------------------
# Static menu tree: menu_id -> (title, body text, rows).
# Each row is a list of (label, callback_data) buttons.
# Dynamic menus (chats / model / skills / jobs) keep only their static
# rows here; tg.py prepends the live rows.
# ---------------------------------------------------------------------
MENUS = {
    "root": (
        "AgentX on Telegram",
        "Pick something — everything here does the same thing as the "
        "console. Only the owner can change settings; everyone else "
        "gets the read-only branches.",
        [
            [("💬 New chat", "ui:n:new")],
            [("📂 My chats", "ui:m:chats")],
            [("⚙️ Settings", "ui:m:set")],
            [("🧠 Memory", "ui:m:mem")],
            [("📋 Board", "ui:m:board")],
            [("🔑 Vault (connectors)", "ui:m:vault")],
            [("💻 Computer", "ui:m:comp")],
            [("💰 Cost", "ui:m:cost")],
            [("📅 Jobs", "ui:m:jobs")],
            [("❌ Close", "ui:x")],
        ],
    ),
    "set": (
        "Settings",
        "Change a setting by tapping it. Every change is written to "
        "the same place the console writes it, and one audit line is "
        "kept (no payloads, no secrets).",
        [
            [("🤖 Model", "ui:m:model")],
            [("✅ Approval", "ui:m:appr")],
            [("🧩 Skills", "ui:m:skills")],
            [("📺 Channel", "ui:m:chan")],
            [("⬅️ Back", "ui:m:root")],
        ],
    ),
    "appr": (
        "Approval level",
        "STRICT asks about everything. SMART auto-runs low-risk tools "
        "and asks about the rest (recommended). AUTO asks only for "
        "guarded tools. OFF disables the guard. JEV is SMART plus a "
        "decision-model check before a tool runs.",
        [
            [("🛡️ STRICT", "act:ap:STRICT")],
            [("🧠 SMART", "act:ap:SMART")],
            [("⚙️ AUTO", "act:ap:AUTO")],
            [("🚫 OFF", "act:ap:OFF")],
            [("🔮 JEV", "act:ap:JEV")],
            [("⬅️ Back", "ui:m:set")],
        ],
    ),
    "mem": (
        "Memory",
        "The compact fact store (memory v2) — not the whole history. "
        "Search costs a few hundred tokens; the full history is never "
        "dumped into a chat.",
        [
            [("🔍 Search memory", "ui:a:memsearch")],
            [("📝 Latest handoff", "ui:a:memhandoff")],
            [("➕ Save a fact", "ui:a:memadd")],
            [("⬅️ Back", "ui:m:root")],
        ],
    ),
    "board": (
        "Board",
        "Tickets live in D1 (one row per ticket). Creating or moving "
        "a ticket needs the board key from Settings.",
        [
            [("📋 List tickets", "ui:a:boardlist")],
            [("➕ New ticket", "ui:a:boardnew")],
            [("⬅️ Back", "ui:m:root")],
        ],
    ),
    "vault": (
        "Vault (connectors only)",
        "The vault holds CONNECTORS (GitHub, Slack, …). API keys for "
        "providers and services go in Settings, not the vault. Values "
        "are never shown here — reveal is console-only.",
        [
            [("🔑 List connectors", "ui:a:vaultlist")],
            [("⬅️ Back", "ui:m:root")],
        ],
    ),
    "comp": (
        "Computer",
        "The machine behind the console. Status is safe to read; Rest "
        "puts the machine to sleep (it wakes when you open the site). "
        "The noVNC desktop view cannot be mirrored over Telegram — "
        "it is an interactive VNC session, not a message.",
        [
            [("📊 Status", "ui:a:compstatus")],
            [("😴 Rest (sleep machine)", "act:g:rest")],
            [("⬅️ Back", "ui:m:root")],
        ],
    ),
    "cost": (
        "Cost",
        "Per-run tokens priced from a static table, with a budget and "
        "a hard stop at 100%. The ledger is the same one the console "
        "cost view reads.",
        [
            [("📊 Show cost", "ui:a:costshow")],
            [("⬅️ Back", "ui:m:root")],
        ],
    ),
    "chan": (
        "Channel",
        "How the bot behaves in Telegram. These write "
        "channels.telegram in working/config.json.",
        [
            [("💬 Require mention (groups)", "act:ch:mention")],
            [("✍️ Typing indicator", "act:ch:typing")],
            [("🔧 Show tool calls", "act:ch:tools")],
            [("💭 Show thinking", "act:ch:think")],
            [("🎬 Streaming", "act:ch:stream")],
            [("⬅️ Back", "ui:m:set")],
        ],
    ),
    "chats": (
        "My chats",
        "Your console chats, newest first. Tap one to see its last "
        "messages, then continue it — your reply goes into that chat, "
        "so the console shows the same conversation.",
        [[("⬅️ Back", "ui:m:root")]],
    ),
    "model": (
        "Model",
        "Pick a provider, then a model. Only providers with a key in "
        "Settings are listed. The change is applied through the same "
        "endpoint the console uses (PATCH /api/agents/<id>/"
        "model-settings) and the agent reloads — no restart.",
        [[("⬅️ Back", "ui:m:set")]],
    ),
    "skills": (
        "Skills",
        "Enable or disable a skill. A new skill stays disabled until "
        "it is enabled here (or in the console).",
        [[("⬅️ Back", "ui:m:set")]],
    ),
    "jobs": (
        "Jobs",
        "Scheduled jobs (native cron). Tap one to turn it on or off. "
        "Running a job right now is console-only.",
        [[("⬅️ Back", "ui:m:root")]],
    ),
}


def menu_title(menu_id: str) -> str:
    return MENUS[menu_id][0]


def menu_text(menu_id: str) -> str:
    return MENUS[menu_id][1]


def menu_rows(menu_id: str):
    """Static rows for a menu (dynamic rows are prepended by tg.py)."""
    return [list(row) for row in MENUS[menu_id][2]]


def build_keyboard(rows) -> dict:
    """Validate rows and build the Bot API inline_keyboard structure.

    rows: list of lists of (label, callback_data). Raises ValueError
    on any invalid callback_data (including the reserved tga:/tgd:).
    """
    keyboard = []
    for row in rows:
        line = []
        for label, data in row:
            if not valid_callback(data):
                raise ValueError(f"invalid callback_data: {data!r}")
            line.append({"text": truncate_label(label),
                         "callback_data": data})
        keyboard.append(line)
    return {"inline_keyboard": keyboard}


# ---------------------------------------------------------------------
# Per-chat token cache: short tokens stand in for long/unstable values
# (provider+model pairs, skill names, job ids) in callback_data.
# ---------------------------------------------------------------------
class MenuCache:
    """(chat_id, token) -> value, TTL + cap, JSON-file backed.

    Callbacks are stateless: everything a tap needs is either in the
    payload or resolvable from this cache, so a bot restart degrades
    to "menu expired, reopen" instead of corruption.
    """

    def __init__(self, max_entries: int = CACHE_MAX_ENTRIES,
                 ttl_seconds: int = CACHE_TTL_SECONDS,
                 path=None):
        self.max_entries = max_entries
        self.ttl_seconds = ttl_seconds
        self.path = Path(path) if path else None
        self._entries: list[dict] = []
        self._counter = 0
        if self.path and self.path.exists():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    self._entries = [e for e in raw.get("entries", [])
                                     if isinstance(e, dict)]
            except Exception:
                self._entries = []
        self._prune()

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"entries": self._entries}),
                           encoding="utf-8")
            tmp.replace(self.path)
        except Exception:
            pass

    def _prune(self) -> None:
        now = time.time()
        self._entries = [e for e in self._entries
                         if now - float(e.get("ts", 0)) < self.ttl_seconds]
        while len(self._entries) > self.max_entries:
            self._entries.pop(0)

    def _next_token(self, chat_id: str) -> str:
        used = {e["token"] for e in self._entries
                if e.get("chat") == str(chat_id)}
        for _ in range(200):
            self._counter += 1
            n = (int(time.time() * 1000) + self._counter) % (36 ** 4)
            token = ""
            for _ in range(4):
                token = _BASE36[n % 36] + token
                n //= 36
            if token not in used:
                return token
        raise RuntimeError("menu token space exhausted")

    def put(self, chat_id, value: str) -> str:
        """Store a value for a chat; return its 4-char token."""
        self._prune()
        token = self._next_token(chat_id)
        self._entries.append({"chat": str(chat_id), "token": token,
                              "value": str(value), "ts": time.time()})
        while len(self._entries) > self.max_entries:
            self._entries.pop(0)
        self._save()
        return token

    def get(self, chat_id, token):
        """Resolve a token; None when missing or expired."""
        self._prune()
        for e in self._entries:
            if e.get("chat") == str(chat_id) and e.get("token") == token:
                return e.get("value")
        return None
