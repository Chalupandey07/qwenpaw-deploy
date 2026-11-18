#!/usr/bin/env python3
"""Short-lived scoped tokens for the sandbox (gap #6, T139).

The trust-boundary redesign, in one sentence: the sandbox NEVER holds
the vault broker token (``VAULT_BROKER_TOKEN`` can make the Worker
dispense ANY vault value). Instead the broker mints a token for ONE
job, scoped to exact vault item names and exact hosts, that expires
in 90 seconds by default and 300 seconds at most, and the sandbox
presents it to the broker's ``/sandbox/inject`` endpoint, which
injects the named value into the child process env only.

Token format (stdlib only, no JWT library needed)::

    v1.<base64url(payload-json)>.<base64url(HMAC-SHA256(payload))>

Payload fields: ``v`` (1), ``kid`` (key id, for rotation), ``jti``
(16 random bytes, hex), ``sub`` (job id), ``aud`` (broker endpoint,
``sandbox-inject``), ``items`` (exact vault item names), ``hosts``
(exact FQDNs), ``ops`` (``["inject-env"]`` only), ``iat``, ``nbf``,
``exp``, ``single_use`` (true).

Verification is exact-match, no wildcards, no prefix match: a token
for item ``github-api`` does not open ``github-api-2``, and a token
for ``api.github.com`` does not open ``evil.github.com``. Expiry is
enforced with 5 s of clock-skew tolerance. A ``jti`` is consumed on
first use (``TokenStore`` holds consumed ids in memory and sweeps
them after expiry); a second presentation of the same token is
refused. There is NO durable revocation: the store dies with the
broker process, so a leaked token stays live until its ``exp`` (at
most 300 s). That is the honest ceiling of a token without a DB, and
it is why the TTL is short. Real revocation is key rotation or a
broker restart.

The signing key is 32 random bytes, hex-encoded, from the env var
``SANDBOX_BROKER_KEY``. It is NEVER logged, NEVER committed, and
NEVER sent to the sandbox: the sandbox only ever sees tokens minted
with it. ``load_key`` fails closed when the var is missing or
malformed. Two keys may be active at once for rotation (``kid`` in
the payload selects which one verifies); the broker keeps the current
key and the previous key.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time

__all__ = [
    "DEFAULT_TTL_S",
    "MAX_TTL_S",
    "CLOCK_SKEW_S",
    "AUDIENCE",
    "ALLOWED_OPS",
    "TokenError",
    "TokenStore",
    "load_key",
    "mint_token",
    "verify_token",
    "token_scope_summary",
]

DEFAULT_TTL_S = 90
MAX_TTL_S = 300
CLOCK_SKEW_S = 5
AUDIENCE = "sandbox-inject"
ALLOWED_OPS = ("inject-env",)

_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_HOST_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,253}$")


class TokenError(ValueError):
    """A token that must not be honoured, with the reason in the message."""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def load_key(env: dict | None = None) -> tuple[str, bytes]:
    """Load the signing key from ``SANDBOX_BROKER_KEY`` (32 bytes, hex).

    Returns ``(kid, key_bytes)``. ``kid`` is the first 8 hex chars of
    SHA-256(key), so rotation is visible in the payload without
    leaking the key. Fails closed: missing, non-hex, or wrong-length
    input raises TokenError. The key value is never printed or logged
    by this module.
    """
    raw = (env if env is not None else os.environ).get("SANDBOX_BROKER_KEY", "")
    raw = raw.strip().strip('"').strip("'").removeprefix("0x")
    try:
        key = bytes.fromhex(raw)
    except ValueError:
        raise TokenError("SANDBOX_BROKER_KEY is not hex")
    if len(key) != 32:
        raise TokenError(
            f"SANDBOX_BROKER_KEY must be 32 bytes, got {len(key)}"
        )
    kid = hashlib.sha256(key).hexdigest()[:8]
    return kid, key


def mint_token(
    key: bytes,
    kid: str,
    job_id: str,
    items: list[str],
    hosts: list[str],
    ttl_s: int = DEFAULT_TTL_S,
    now: float | None = None,
) -> str:
    """Mint a short-lived scoped token for one job.

    ``items``: exact vault item names (``^[a-z][a-z0-9_-]{0,63}$``).
    ``hosts``: exact FQDNs the job may reach through the egress proxy.
    ``ttl_s``: seconds until expiry; refused above MAX_TTL_S (300 s).
    Raises TokenError on any bad input. The token carries NO vault
    value — only names. A name is not a credential.
    """
    if not job_id or not isinstance(job_id, str):
        raise TokenError("job_id is required")
    if ttl_s <= 0 or ttl_s > MAX_TTL_S:
        raise TokenError(f"ttl_s must be 1..{MAX_TTL_S}, got {ttl_s}")
    clean_items = sorted({i for i in (items or []) if i})
    clean_hosts = sorted({h.lower() for h in (hosts or []) if h})
    if not clean_items and not clean_hosts:
        raise TokenError("token needs at least one item or host scope")
    for item in clean_items:
        if not _NAME_RE.match(item):
            raise TokenError(f"bad vault item name in scope: {item!r}")
    for host in clean_hosts:
        if not _HOST_RE.match(host) or ".." in host:
            raise TokenError(f"bad host in scope: {host!r}")
    moment = int(now if now is not None else time.time())
    payload = {
        "v": 1,
        "kid": kid,
        "jti": secrets.token_hex(16),
        "sub": job_id,
        "aud": AUDIENCE,
        "items": clean_items,
        "hosts": clean_hosts,
        "ops": list(ALLOWED_OPS),
        "iat": moment,
        "nbf": moment,
        "exp": moment + int(ttl_s),
        "single_use": True,
    }
    body = _b64url(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    sig = _b64url(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest())
    return f"v1.{body}.{sig}"


def verify_token(
    token: str,
    keys: dict[str, bytes],
    required_item: str | None = None,
    required_host: str | None = None,
    job_id: str | None = None,
    now: float | None = None,
    store: "TokenStore | None" = None,
) -> dict:
    """Verify a token and its scope. Returns the payload dict on success.

    Raises TokenError when the token must not be honoured: bad format,
    unknown key id, bad signature (tamper), wrong audience, not yet
    valid, expired, wrong job, item/host outside the scope, or a
    ``jti`` already consumed (replay). When ``store`` is given, a
    successful verification consumes the ``jti``: the same token
    cannot verify twice.
    """
    moment = int(now if now is not None else time.time())
    parts = (token or "").split(".")
    if len(parts) != 3 or parts[0] != "v1":
        raise TokenError("bad token format")
    _, body, sig = parts
    try:
        payload = json.loads(_b64url_decode(body))
    except (ValueError, UnicodeDecodeError):
        raise TokenError("bad token payload")
    if not isinstance(payload, dict) or payload.get("v") != 1:
        raise TokenError("bad token version")
    kid = payload.get("kid")
    key = keys.get(kid) if isinstance(kid, str) else None
    if key is None:
        raise TokenError("unknown key id")
    expected = _b64url(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, sig):
        raise TokenError("bad token signature")
    if payload.get("aud") != AUDIENCE:
        raise TokenError("bad token audience")
    if payload.get("ops") != list(ALLOWED_OPS):
        raise TokenError("bad token ops")
    exp = payload.get("exp")
    nbf = payload.get("nbf")
    if not isinstance(exp, int) or not isinstance(nbf, int):
        raise TokenError("bad token times")
    if moment > exp + CLOCK_SKEW_S:
        raise TokenError("token expired")
    if moment < nbf - CLOCK_SKEW_S:
        raise TokenError("token not yet valid")
    if job_id is not None and payload.get("sub") != job_id:
        raise TokenError("token is for a different job")
    if required_item is not None and required_item not in (payload.get("items") or []):
        raise TokenError(f"item {required_item!r} is outside the token scope")
    if required_host is not None and required_host.lower() not in (payload.get("hosts") or []):
        raise TokenError(f"host {required_host!r} is outside the token scope")
    jti = payload.get("jti")
    if not isinstance(jti, str) or not jti:
        raise TokenError("bad token id")
    if store is not None:
        if store.is_consumed(jti):
            raise TokenError("token already used")
        store.consume(jti, exp)
    return payload


def token_scope_summary(token: str) -> dict:
    """Decode a token's payload WITHOUT verifying it (for logging only).

    Returns ``{}`` for anything unparseable. Never use this to decide
    access: only ``verify_token`` decides. The summary contains names
    only — no vault value can ever be in a token.
    """
    try:
        body = (token or "").split(".")[1]
        payload = json.loads(_b64url_decode(body))
    except (IndexError, ValueError, UnicodeDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        "job_id": payload.get("sub"),
        "items": payload.get("items"),
        "hosts": payload.get("hosts"),
        "exp": payload.get("exp"),
        "single_use": payload.get("single_use"),
    }


class TokenStore:
    """In-memory consumed-``jti`` set for single-use tokens.

    A ``jti`` is remembered until its token's ``exp`` passes, then
    swept. The store is deliberately in-memory: it dies with the
    broker process, so a restart forgets consumed ids — but every
    token also expires within 300 s, so the replay window after a
    restart is bounded by the TTL, not open-ended. There is no DB
    behind this; that is a documented ceiling, not an oversight.
    """

    def __init__(self) -> None:
        self._consumed: dict[str, int] = {}

    def is_consumed(self, jti: str) -> bool:
        return jti in self._consumed

    def consume(self, jti: str, exp: int) -> None:
        self._consumed[jti] = int(exp)

    def sweep(self, now: float | None = None) -> int:
        """Drop entries whose token has expired. Returns how many dropped."""
        moment = int(now if now is not None else time.time())
        stale = [j for j, e in self._consumed.items() if e + CLOCK_SKEW_S < moment]
        for j in stale:
            del self._consumed[j]
        return len(stale)

    def __len__(self) -> int:
        return len(self._consumed)


def _main(argv: list[str]) -> int:
    """Tiny CLI for the broker operator (mint / verify), key from env.

    Usage: vault_tokens.py mint <job_id> <item,...> <host,...> [ttl]
           vault_tokens.py verify <token> [item] [host]
    The key is read from SANDBOX_BROKER_KEY only. Nothing is printed
    except the token / the verdict — never the key.
    """
    if len(argv) < 2:
        print("usage: vault_tokens.py mint <job> <items> <hosts> [ttl] | verify <token> [item] [host]")
        return 2
    try:
        kid, key = load_key()
    except TokenError as exc:
        print(f"error: {exc}")
        return 1
    if argv[1] == "mint":
        if len(argv) < 5:
            print("usage: vault_tokens.py mint <job> <items> <hosts> [ttl]")
            return 2
        items = [i for i in argv[3].split(",") if i]
        hosts = [h for h in argv[4].split(",") if h]
        ttl = int(argv[5]) if len(argv) > 5 else DEFAULT_TTL_S
        try:
            print(mint_token(key, kid, argv[2], items, hosts, ttl_s=ttl))
        except TokenError as exc:
            print(f"error: {exc}")
            return 1
        return 0
    if argv[1] == "verify":
        if len(argv) < 3:
            print("usage: vault_tokens.py verify <token> [item] [host]")
            return 2
        try:
            payload = verify_token(argv[2], {kid: key},
                                   required_item=argv[3] if len(argv) > 3 else None,
                                   required_host=argv[4] if len(argv) > 4 else None)
        except TokenError as exc:
            print(f"error: {exc}")
            return 1
        print(f"ok job={payload['sub']} items={','.join(payload['items'])} "
              f"hosts={','.join(payload['hosts'])} exp={payload['exp']}")
        return 0
    print(f"unknown command: {argv[1]}")
    return 2


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv))
