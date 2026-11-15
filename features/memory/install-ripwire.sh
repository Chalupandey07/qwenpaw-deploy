#!/usr/bin/env bash
# Install ripwire on the InstaBox host and expose it to the QwenPaw container.
#
# WHY A SCRIPT AND NOT "just download the binary"
# ----------------------------------------------
# Four things can silently go wrong, and each one is checked BEFORE anything
# is written:
#
#   1. CPU baseline. The linux-x64 release is built for x86-64-v3 (AVX2).
#      The x86-64-v3 feature set is avx + avx2 + bmi1 + bmi2 + f16c + fma +
#      lzcnt + movbe (+ xsave). An older vCPU SIGILLs on the first vector
#      instruction — which looks like a corrupt binary, not a CPU mismatch.
#      NOTE: "lzcnt" is reported by Linux as the "abm" flag, so grepping for
#      the literal string "lzcnt" gives a FALSE NEGATIVE. This script checks
#      abm|lzcnt.
#   2. Disk. The host root is a 20 GiB volume and /tmp is a 512 MB tmpfs that
#      has been 100% full before. Nothing large goes to /tmp, ever.
#   3. Integrity. The release ships a .sha256 sidecar; it is verified before
#      the tarball is unpacked.
#   4. Idempotency. Re-running must be safe: a second run replaces the binary
#      only if the version differs, and never leaves a half-written file.
#
# Idempotent, read-only with respect to QwenPaw state: it does not touch
# `.env`, `auth.json`, chats, or any container. It does NOT restart anything.
#
# Usage (run on the InstaBox host, as the user that owns /data/home):
#   bash install-ripwire.sh              # install or upgrade to PINNED_VERSION
#   bash install-ripwire.sh --check      # preflight only, changes nothing
#   bash install-ripwire.sh --version 0.6.10
#
# Exit codes: 0 ok, 2 preflight refused (with the reason), 3 download/verify
# failed.

set -euo pipefail

PINNED_VERSION="0.6.10"
PREFIX="/data/home/ripwire"
BIN_NAME="ripwire"
CHECK_ONLY=0
VERSION="$PINNED_VERSION"

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --version) shift; VERSION="${1:-}" ;;
    --prefix) shift; PREFIX="${1:-}" ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'REFUSED: %s\n' "$*" >&2; exit 2; }

say "ripwire installer — target $PREFIX, version $VERSION"

# ---------------------------------------------------------------- 1. arch
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ASSET_ARCH="linux-x64" ;;
  aarch64|arm64) ASSET_ARCH="linux-arm64" ;;
  *) fail "unsupported architecture '$ARCH' (ripwire ships linux-x64 and linux-arm64)" ;;
esac
say "  arch: $ARCH -> $ASSET_ARCH"

# ------------------------------------------------------- 2. CPU baseline
# Only the x64 build needs the v3 check; the arm64 build has no such gate.
if [ "$ASSET_ARCH" = "linux-x64" ]; then
  [ -r /proc/cpuinfo ] || fail "/proc/cpuinfo is unreadable, cannot verify the CPU baseline"
  FLAGS="$(grep -m1 '^flags' /proc/cpuinfo | cut -d: -f2 || true)"
  [ -n "$FLAGS" ] || fail "no 'flags' line in /proc/cpuinfo — cannot verify AVX2"

  missing=""
  for need in avx avx2 bmi1 bmi2 f16c fma movbe; do
    printf '%s\n' "$FLAGS" | tr ' ' '\n' | grep -qx "$need" || missing="$missing $need"
  done
  # lzcnt is exposed as 'abm' on Linux; accept either spelling.
  if ! printf '%s\n' "$FLAGS" | tr ' ' '\n' | grep -qxE 'abm|lzcnt'; then
    missing="$missing lzcnt(abm)"
  fi

  if [ -n "$missing" ]; then
    fail "CPU is not x86-64-v3 capable; missing:$missing
         The linux-x64 release is built for x86-64-v3 and would SIGILL.
         Options: use the linux-arm64 build on ARM, or build from source with
         -march=x86-64 (the ripwire repo supports a cmake build), or skip
         ripwire entirely — features/memory/recall.py does not depend on it."
  fi
  say "  cpu : x86-64-v3 baseline present (avx2 + bmi + fma + abm/lzcnt)"
fi

# ------------------------------------------------------------- 3. disk
PARENT="$(dirname "$PREFIX")"
[ -d "$PARENT" ] || fail "parent directory $PARENT does not exist"
AVAIL_KB="$(df -Pk "$PARENT" | awk 'NR==2 {print $4}')"
# ~11 MB tarball, ~58 MB binary, keep a 200 MB floor so an install cannot
# fill the volume it shares with QwenPaw.
NEED_KB=$((200 * 1024))
if [ "${AVAIL_KB:-0}" -lt "$NEED_KB" ]; then
  fail "only ${AVAIL_KB} KB free on $PARENT; need at least ${NEED_KB} KB.
         Do not install into a full volume — QwenPaw shares it."
fi
say "  disk: $((AVAIL_KB / 1024)) MB free on $PARENT"

case "$PREFIX" in
  /tmp|/tmp/*) fail "refusing to install under /tmp — it is a 512 MB tmpfs on this box and has been 100% full" ;;
esac

# --------------------------------------------------- 4. already installed?
TARGET="$PREFIX/$BIN_NAME"
if [ -x "$TARGET" ]; then
  HAVE="$("$TARGET" --version 2>/dev/null | awk '{print $2}' || true)"
  if [ "$HAVE" = "$VERSION" ]; then
    say "  state: already at $VERSION — nothing to do"
    if [ "$CHECK_ONLY" = 1 ]; then exit 0; fi
    say "OK"
    exit 0
  fi
  say "  state: have ${HAVE:-unknown}, want $VERSION — will upgrade"
else
  say "  state: not installed"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  say "PREFLIGHT OK — no changes made (--check)"
  exit 0
fi

# -------------------------------------------------------- 5. fetch+verify
# The temp dir must live beside the prefix, not inside it: the prefix may not
# exist yet on a first install (mktemp -d does not create leading dirs).
TMPDIR_INSTALL="$(mktemp -d "$PARENT/.ripwire-install.XXXXXX")"
cleanup() { rm -rf "$TMPDIR_INSTALL"; }
trap cleanup EXIT HUP INT TERM

TARBALL="ripwire-${VERSION}-${ASSET_ARCH}.tar.gz"
BASE="https://github.com/redhat-et/ripwire/releases/download/v${VERSION}"

say "  fetch: $TARBALL"
if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 300 \
      -o "$TMPDIR_INSTALL/$TARBALL" "$BASE/$TARBALL"; then
  echo "download failed: $BASE/$TARBALL" >&2
  exit 3
fi
if ! curl -fsSL --retry 3 --max-time 60 \
      -o "$TMPDIR_INSTALL/$TARBALL.sha256" "$BASE/$TARBALL.sha256"; then
  echo "checksum sidecar download failed" >&2
  exit 3
fi

EXPECTED="$(awk '{print $1}' "$TMPDIR_INSTALL/$TARBALL.sha256")"
ACTUAL="$(sha256sum "$TMPDIR_INSTALL/$TARBALL" | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "CHECKSUM MISMATCH for $TARBALL" >&2
  echo "  expected $EXPECTED" >&2
  echo "  actual   $ACTUAL" >&2
  exit 3
fi
say "  sha256: verified"

# ------------------------------------------------------------- 6. unpack
tar -xzf "$TMPDIR_INSTALL/$TARBALL" -C "$TMPDIR_INSTALL"
SRC_BIN="$(find "$TMPDIR_INSTALL" -maxdepth 2 -type f -name "$BIN_NAME" | head -1)"
[ -n "$SRC_BIN" ] || { echo "no '$BIN_NAME' binary inside the tarball" >&2; exit 3; }

# Probe the binary BEFORE installing it: a SIGILL here is a clean failure
# instead of a broken install.
if ! "$SRC_BIN" --version >/dev/null 2>&1; then
  echo "the downloaded binary does not run on this CPU (SIGILL?) — not installing" >&2
  exit 3
fi

say "  probe: $("$SRC_BIN" --version 2>/dev/null | head -1)"

SRC_TREE="$(dirname "$SRC_BIN")"
mkdir -p "$PREFIX"
# Atomic replace: write beside the target, then rename.
install -m 0755 "$SRC_BIN" "$PREFIX/.ripwire.new"
mv -f "$PREFIX/.ripwire.new" "$TARGET"

# The upstream agent skills travel with the binary. They are copied (not
# symlinked) so an upgrade cannot leave dangling links; a re-install
# replaces them wholesale.
if [ -d "$SRC_TREE/skills" ]; then
  rm -rf "$PREFIX/skills.new"
  cp -R "$SRC_TREE/skills" "$PREFIX/skills.new"
  rm -rf "$PREFIX/skills"
  mv "$PREFIX/skills.new" "$PREFIX/skills"
  say "  skills: $(find "$PREFIX/skills" -maxdepth 1 -mindepth 1 -type d | wc -l) upstream skill(s) installed"
fi

FINAL="$("$TARGET" --version 2>/dev/null | head -1)"
say "  done : $FINAL"

# ------------------------------------------------------- 7. container view
# The QwenPaw container mounts /data/home/qwenpaw/working as /app/working.
# Ripwire lives OUTSIDE that mount, so it is not visible inside the container
# until the compose file adds it. Say so instead of pretending it works.
COMPOSE="/data/home/qwenpaw/docker-compose.yml"
if [ -f "$COMPOSE" ] && ! grep -q '/data/home/ripwire' "$COMPOSE"; then
  say ""
  say "NOTE: the QwenPaw container cannot see $PREFIX yet."
  say "      To expose it read-only, add this line under the qwenpaw service's"
  say "      volumes: in $COMPOSE (then recreate the container — an env/volume"
  say "      change is the one proven exception to the no-restart rule):"
  say ""
  say "        - /data/home/ripwire:/data/home/ripwire:ro"
  say ""
  say "      and set on the service: RIPWIRE_BIN=/data/home/ripwire/ripwire"
  say "      This script deliberately does not edit docker-compose.yml: a"
  say "      recreate drops the running agent's in-flight work, so Muse decides"
  say "      when. features/memory/recall.py needs none of this."
fi

say "OK — ripwire $VERSION at $TARGET"
