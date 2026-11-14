# Vault inventory — secret NAMES only (never values)

Verified live 2026-11-15 by listing directories on machine
`m_agq5wqqo2fvypym7rjlpvngc2m`. No file content was read. If a name is
listed here, the file exists; nothing about its value is recorded anywhere
in this repo.

## `working.secret/` (root-owned, mode 0700 dir)

| Name | What it is | Notes |
|------|-----------|-------|
| `auth.json` | Console login accounts | **Never touch.** Account `satwik` lives here. |
| `.master_key` | QwenPaw credential-encryption key (64 bytes) | **Never copy, share, or print.** |
| `chatgpt/` | Directory | ChatGPT-related stored data (contents not listed). |
| `providers/` | Directory | LLM provider credentials (below). |

## `working.secret/providers/`

| Name | What it is | Notes |
|------|-----------|-------|
| `active_model.json` | Which provider/model is active | Verified value shape earlier: `kilo/kilo-auto/free`. |
| `builtin/kilo.json` | Kilo provider credential | Active provider. |
| `builtin/lmstudio.json` | LM Studio provider credential | Local-model provider; not used (cloud LLM only). |
| `builtin/ollama.json` | Ollama provider credential | Local-model provider; not used. |
| `builtin/openrouter.json` | OpenRouter provider credential | Present; active status not verified here. |
| `custom/xingchiapi.json` | GPT Astra (xingchiapi) custom provider | Models `gpt-6-astra` / `gpt-6.1-sol`. |
| `plugin/` | Directory | Empty at check time. |

## What is NOT in the vault (gaps the user should know)

- **No Gmail/mailbox credential**: `qwenpawmail` MCP is not configured
  (see `17-bot-email.md`). No mailbox `auth_code` exists yet.
- **No Twilio / LiveKit / Deepgram / Google TTS credential**: voice
  fields are empty (see `05-voice-calls.md`).
- **No Cloudflare / InstaBox API key on the machine**: those live in the
  Muse connector store, not on the machine. The keepalive Worker holds
  `INSTABOX_API_KEY` only as a Worker Secret (optional).

## Handling rules

1. Never print, copy, or commit a value. Names only.
2. Never edit `auth.json` or `.master_key`.
3. Add a provider only via Console → Settings → Models (writes here).
4. Rotate by replacing the file on the machine + container restart
   (restart assumed necessary; not verified).
5. This inventory must be re-checked after any provider change; it is a
   snapshot, not a live view.
