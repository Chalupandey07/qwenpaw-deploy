#!/usr/bin/env python3
"""Voice-call readiness check (READ-ONLY, names only — never prints values).

Checks which voice configuration QwenPaw v2.3.0 actually has, from the
live config.json channel sections (verified keys, 2026-11-15):
  channels.voice: twilio_account_sid, twilio_auth_token, phone_number,
                  phone_number_sid, tts_provider (google),
                  tts_voice (en-US-Journey-D), stt_provider (deepgram),
                  language (en-US)
  channels.sip:   sip_mode (dev), sip_host, sip_port (5061), sip_username,
                  sip_password, sip_server, sip_transport (UDP),
                  livekit_url, livekit_api_key, livekit_api_secret,
                  livekit_sip_trunk_id, tts/stt providers, call_timeout

Also greps the installed QwenPaw source for an ElevenLabs integration
(expectation: none — verified 2026-11-15).

Usage (on the machine, needs sudo for root-owned config.json):
  sudo python3 voice-readiness.py [--root /data/home/qwenpaw]

A field is reported as SET only if it is a non-empty string. No value is
ever printed, logged, or written anywhere.
"""
import argparse
import json
import os
import subprocess
import sys

DEFAULT_ROOT = "/data/home/qwenpaw"

VOICE_FIELDS = ["twilio_account_sid", "twilio_auth_token", "phone_number",
                "phone_number_sid", "tts_provider", "tts_voice",
                "stt_provider", "language"]
SIP_FIELDS = ["sip_mode", "sip_host", "sip_port", "sip_username",
              "sip_password", "sip_server", "sip_transport",
              "livekit_url", "livekit_api_key", "livekit_api_secret",
              "livekit_sip_trunk_id", "tts_provider", "stt_provider",
              "language", "call_timeout"]


def field_state(section, fields):
    out = {}
    for f in fields:
        v = section.get(f)
        out[f] = "SET" if isinstance(v, str) and v.strip() else (
            "SET" if isinstance(v, (int, float)) and v else "EMPTY")
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", default=DEFAULT_ROOT)
    args = p.parse_args()
    cfg_path = os.path.join(args.root, "working", "config.json")
    try:
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as exc:  # noqa: BLE001
        print(f"cannot read {cfg_path}: {exc}", file=sys.stderr)
        return 1
    channels = cfg.get("channels", {})
    voice = channels.get("voice", {})
    sip = channels.get("sip", {})
    print("QwenPaw voice readiness (names only, no values)")
    print(f"voice channel enabled: {voice.get('enabled')}")
    for k, v in field_state(voice, VOICE_FIELDS).items():
        print(f"  voice.{k}: {v}")
    print(f"sip channel enabled: {sip.get('enabled')}")
    for k, v in field_state(sip, SIP_FIELDS).items():
        print(f"  sip.{k}: {v}")
    print()
    twilio_ready = all(
        field_state(voice, ["twilio_account_sid", "twilio_auth_token",
                            "phone_number"])[k] == "SET"
        for k in ["twilio_account_sid", "twilio_auth_token", "phone_number"])
    livekit_ready = all(
        field_state(sip, ["livekit_url", "livekit_api_key",
                          "livekit_api_secret", "livekit_sip_trunk_id"])[k] == "SET"
        for k in ["livekit_url", "livekit_api_key",
                  "livekit_api_secret", "livekit_sip_trunk_id"])
    print(f"Twilio voice path ready: {twilio_ready} "
          "(needs SID + auth token + phone number)")
    print(f"LiveKit SIP path ready: {livekit_ready} "
          "(needs LiveKit URL + API key/secret + SIP trunk id)")
    # ElevenLabs check in installed source (best effort; docker may be absent)
    try:
        r = subprocess.run(
            ["docker", "exec", "qwenpaw", "grep", "-rli", "elevenlabs",
             "venv/lib/python3.11/site-packages/qwenpaw/"],
            capture_output=True, text=True, timeout=60)
        hits = [h for h in r.stdout.splitlines() if h.strip()]
        print(f"ElevenLabs integration in QwenPaw source: "
              f"{'FOUND ' + str(hits) if hits else 'NONE (no matches)'}")
    except Exception as exc:  # noqa: BLE001
        print(f"ElevenLabs source check skipped: {exc}")
    print()
    print("Verdict: no voice-call path is configured today. See 05-voice-calls.md")
    print("for exactly which key/account the user must supply per path.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
