# #5 — Voice calls

Status: **Blocked (needs keys).** No real phone call can be placed or
received today, and no zero-paid-key path for real calls exists. What is
built: the exact requirements per path (verified against live config and
public pricing), plus a readiness script.

## What was checked live (2026-11-15)

1. **QwenPaw voice channels exist in config and are all empty/disabled.**
   `channels.voice` (`enabled: false`): `twilio_account_sid ""`,
   `twilio_auth_token ""`, `phone_number ""`, `phone_number_sid ""`;
   TTS `google`, voice `en-US-Journey-D`; STT `deepgram`; language `en-US`;
   greeting "Hi! This is QwenPaw. How can I help you?".
   `channels.sip` (`enabled: false`): `sip_mode "dev"`, `sip_port 5061`,
   `livekit_url ""`, `livekit_api_key ""`, `livekit_api_secret ""`,
   `livekit_sip_trunk_id ""`; TTS google, STT deepgram.
2. **Voice ingress exists in code but has no service behind it.**
   `/voice/incoming` (TwiML-style), `/voice/ws`, `/voice/status-callback`
   delegate to a `channel_ingress` plugin service; with no service the
   endpoint returns 503 / "Voice channel is not available."
3. **No ElevenLabs integration anywhere in the installed QwenPaw source**
   (grep over `site-packages/qwenpaw/` returned nothing).
4. Run `scripts/voice-readiness.py` on the machine any time to re-check
   which fields are set (names only, never values).

## Paths, and exactly what each needs

### A. Twilio voice channel (built into QwenPaw — the direct path)

Needs from the user: a Twilio account + **Account SID**, **Auth Token**,
and a **purchased phone number**, entered in Console → Settings →
Channels → Voice, then enable the channel.

Verified pricing (Twilio US price list, Oct 2026; third-party summaries
agree): $15 trial credit for new accounts; US local number $1.15/mo;
receive $0.0085/min, place $0.0140/min (US). Trial accounts can call only
verified numbers and expire after 30 days per Twilio docs summaries.
For India: outbound to Indian mobiles $0.0496/min, landlines $0.0699/min
(Sept 2026); Twilio sells no Indian local/mobile numbers — only
international numbers from $1.15/mo. Confirm on Twilio's pricing page
before budgeting; prices change.

### B. SIP via LiveKit (fields already in QwenPaw's SIP channel)

Needs from the user: a LiveKit Cloud project + **LiveKit URL, API key,
API secret, SIP trunk ID**, entered in the SIP channel settings, plus a
phone number on a SIP trunk.

Verified pricing (LiveKit pricing page via third-party summaries, Oct–Nov
2026): **Build plan is free** — 1,000 agent session minutes/mo, 5
concurrent sessions, **1 free US local number, 50 US local inbound
minutes/mo**, 1,000 third-party SIP minutes; Build is a hard cap (requests
fail when it runs out, nothing is billed). Ship is $50/mo. This is the
cheapest real path to a working phone line — but it is **not built or
tested here**: the QwenPaw↔LiveKit bridge (LiveKit room → QwenPaw agent)
is not part of this build and its wiring is unverified. Expect a build +
test step with the coordinator before it can take a call.

### C. ElevenLabs agent (separate product, not QwenPaw)

No integration in QwenPaw. An ElevenLabs conversational agent with a
phone number is a separate agent, not this QwenPaw, and needs an
ElevenLabs account + phone number (paid). It would not share QwenPaw's
memory, workspace, or tools. Only choose this if the user wants a
standalone voice agent instead of QwenPaw on the phone.

### D. Worker + WebRTC (investigated, not viable as a phone path)

A Cloudflare Worker cannot terminate a PSTN call. Browser-voice
(WebRTC) still needs a media server (LiveKit, or Cloudflare Calls) and a
QwenPaw voice bridge — same missing pieces as path B, with no phone
number at the end. Not built.

## What is NOT built

- No Twilio account, no phone number, no keys — nothing was invented.
  Every credential field above is empty today.
- No live test call has been made (there is no number to call).

## What the user must supply (pick one path)

- **Path A**: Twilio SID + auth token + phone number.
- **Path B (cheapest)**: LiveKit Cloud free Build account + URL/key/secret
  + SIP trunk ID + number; then a bridge build + test call with the
  coordinator.
- **Path C**: ElevenLabs account + number, accepting it is a separate agent.
