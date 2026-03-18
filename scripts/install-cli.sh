#!/bin/bash
#
# Install (or update) the pi CLI from the lyfegame fork.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/lyfegame/pi-mono/main/scripts/install-cli.sh | bash
#   # or with options:
#   BRANCH=main PI_HOME=~/.pi-source bash scripts/install-cli.sh
#
# Environment variables:
#   BRANCH      Git branch to install (default: main)
#   PI_HOME     Where to clone the repo (default: ~/.pi-source)
#   BIN_DIR     Where to symlink the `pi` binary (default: ~/.local/bin)
#   WITH_LANGFUSE  Set to 1 to install optional Langfuse/OTel dependencies
#
set -euo pipefail

REPO="https://github.com/lyfegame/pi-mono.git"
BRANCH="${BRANCH:-main}"
PI_HOME="${PI_HOME:-$HOME/.pi-source}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
WITH_LANGFUSE="${WITH_LANGFUSE:-0}"

info() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── Prerequisites ────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || err "node is required (>= 20.6.0). Install from https://nodejs.org"
command -v npm  >/dev/null 2>&1 || err "npm is required"
command -v git  >/dev/null 2>&1 || err "git is required"

NODE_MAJOR=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || err "node >= 20 required, found $(node -v)"

# ── Clone or update ─────────────────────────────────────────────────────────

if [ -d "$PI_HOME/.git" ]; then
  info "Updating existing install at $PI_HOME (branch: $BRANCH)"
  cd "$PI_HOME"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  info "Cloning $REPO → $PI_HOME (branch: $BRANCH)"
  git clone --depth 1 -b "$BRANCH" "$REPO" "$PI_HOME"
  cd "$PI_HOME"
fi

# ── Install dependencies ────────────────────────────────────────────────────

info "Installing npm dependencies…"
npm install --no-audit --no-fund

if [ "$WITH_LANGFUSE" = "1" ]; then
  info "Installing optional Langfuse/OTel dependencies…"
  npm install --no-save \
    @langfuse/otel \
    @langfuse/tracing \
    @opentelemetry/api \
    @opentelemetry/sdk-trace-node
fi

# ── Build ────────────────────────────────────────────────────────────────────

info "Building…"
npm run build

# ── Symlink ──────────────────────────────────────────────────────────────────

mkdir -p "$BIN_DIR"
CLI_JS="$PI_HOME/packages/coding-agent/dist/cli.js"
[ -f "$CLI_JS" ] || err "Build did not produce $CLI_JS"

ln -sf "$CLI_JS" "$BIN_DIR/pi"
chmod +x "$BIN_DIR/pi"

ok "Installed pi → $BIN_DIR/pi"

# ── PATH check ───────────────────────────────────────────────────────────────

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "  ⚠  $BIN_DIR is not in your PATH. Add it:"
    echo ""
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    echo ""
    ;;
esac

ok "Done! Run 'pi --help' to get started."
echo "  To update later: BRANCH=$BRANCH bash $PI_HOME/scripts/install-cli.sh"
