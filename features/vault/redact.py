"""Shared redaction module for the vault broker and any skill that handles
tool output.

Python port of pages/public/vault/crypto.js (redactionForms / redactText /
makeStreamRedactor). The two implementations MUST agree on the form sets:
if one redacts a form the other misses, the value leaks through the path
that misses it. Keep them in sync; the harness (harness-vault.mjs) tests
both against the same fixtures.

Design (DeepSeek design review, 2026-11-17):
  - Per-kind form sets, ranked by reachability. Base64 of a whole header
    and base64 of a header value are NOT generated (over-engineering).
  - Minimum form length 8 (6-char forms cause collateral redaction).
  - Overlapping matches are merged by collecting ALL ranges manually —
    never one alternation regex, which returns non-overlapping matches and
    silently drops overlapping longer forms.
  - Multi-line values contribute the full value AND each long unspaced line.
"""

import base64
import json
import urllib.parse

REDACTED = "[redacted]"
MIN_FORM_LENGTH = 8


def _add(out, x):
    if isinstance(x, str) and len(x) >= MIN_FORM_LENGTH:
        out.add(x)


def redaction_forms(kind, value, header_name=None, username=None):
    """The exact set of strings that must never appear in model-visible text."""
    v = str(value or "")
    out = set()
    _add(out, v)
    # JSON-escaped (tool output is usually JSON).
    _add(out, json.dumps(v)[1:-1])
    # Percent-encoded.
    _add(out, urllib.parse.quote(v, safe=""))

    if kind == "bearer":
        _add(out, "Bearer " + v)
        _add(out, "bearer " + v)
        _add(out, "BEARER " + v)
    elif kind == "basic":
        # `value` is the base64 of user:password (the stored form).
        b64 = v
        if b64.lower().startswith("basic "):
            b64 = b64[6:]
        _add(out, b64)
        _add(out, "Basic " + b64)
        _add(out, "basic " + b64)
        _add(out, urllib.parse.quote(b64, safe=""))
        try:
            decoded = base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)).decode("utf-8")
            _add(out, decoded)  # user:pass
            _add(out, urllib.parse.quote(decoded, safe=""))  # user%3Apass
            if ":" in decoded:
                _add(out, decoded.split(":", 1)[1])  # password alone
                if username:
                    _add(out, username + ":" + decoded.split(":", 1)[1])
        except Exception:
            pass
    elif kind == "header":
        if header_name:
            _add(out, header_name + ": " + v)

    if "\n" in v:
        for line in v.split("\n"):
            _add(out, line.strip())
    return sorted(out)


def _merge_ranges(text, forms):
    ranges = []
    for f in forms:
        start = 0
        while True:
            i = text.find(f, start)
            if i == -1:
                break
            ranges.append((i, i + len(f)))
            start = i + 1
    # Start asc, longer first.
    ranges.sort(key=lambda r: (r[0], -(r[1] - r[0])))
    merged = []
    for s, e in ranges:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def redact(text, forms):
    """Replace every form in `text` with [redacted]."""
    if not isinstance(text, str) or not text or not forms:
        return text
    merged = _merge_ranges(text, forms)
    if not merged:
        return text
    out = []
    p = 0
    for s, e in merged:
        out.append(text[p:s])
        out.append(REDACTED)
        p = e
    out.append(text[p:])
    return "".join(out)


class StreamRedactor:
    """Streaming redactor. Needed only where text reaches the model WITHOUT
    full buffering (a live child process's stdout). Correctness invariant:
    any match is at most maxLen chars, so holding back maxLen - 1 chars
    means every match that STARTS in the emitted region is fully present
    in the buffer. Memory is bounded by the longest form."""

    def __init__(self, forms):
        self.forms = list(forms)
        self.max_len = max(1, max((len(f) for f in self.forms), default=1))
        self.buf = ""

    def push(self, chunk):
        self.buf += chunk
        cut = len(self.buf) - (self.max_len - 1)
        if cut <= 0:
            return ""
        merged = _merge_ranges(self.buf, self.forms)
        emit = cut
        for s, e in merged:
            if s < cut and e > emit:
                emit = e
        out = []
        p = 0
        for s, e in merged:
            if e <= emit:
                out.append(self.buf[p:s])
                out.append(REDACTED)
                p = e
            else:
                break
        out.append(self.buf[p:emit])
        self.buf = self.buf[emit:]
        return "".join(out)

    def flush(self):
        out = redact(self.buf, self.forms)
        self.buf = ""
        return out
