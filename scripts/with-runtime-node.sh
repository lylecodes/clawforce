#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  echo "Usage: scripts/with-runtime-node.sh <node-script> [args...]" >&2
  exit 1
fi
shift || true

if [[ "$TARGET" != /* ]]; then
  TARGET="$ROOT_DIR/$TARGET"
fi

if [ ! -f "$TARGET" ]; then
  echo "Runtime target not found: $TARGET" >&2
  exit 1
fi

REQUIRED_NODE_VERSION=""
if [ -f "$ROOT_DIR/.nvmrc" ]; then
  REQUIRED_NODE_VERSION="$(tr -d '[:space:]' < "$ROOT_DIR/.nvmrc")"
fi

normalize_version() {
  local value="${1:-}"
  value="${value#v}"
  printf '%s' "$value"
}

node_version() {
  local node_bin="${1:-}"
  if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
    return 1
  fi
  "$node_bin" -v 2>/dev/null | tr -d '[:space:]'
}

matches_required_version() {
  local node_bin="${1:-}"
  if [ -z "$REQUIRED_NODE_VERSION" ]; then
    return 0
  fi
  local actual
  actual="$(normalize_version "$(node_version "$node_bin")")" || return 1
  [ "$actual" = "$(normalize_version "$REQUIRED_NODE_VERSION")" ]
}

NODE_BIN="${CLAWFORCE_NODE_BIN:-}"

if [ -n "$NODE_BIN" ] && [ ! -x "$NODE_BIN" ]; then
  echo "CLAWFORCE_NODE_BIN is set but not executable: $NODE_BIN" >&2
  exit 1
fi

if [ -z "$NODE_BIN" ] && [ -n "$REQUIRED_NODE_VERSION" ]; then
  NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [ -s "$NVM_SH" ]; then
    unset npm_config_prefix NPM_CONFIG_PREFIX PREFIX
    # shellcheck disable=SC1090
    . "$NVM_SH"
    if [ "$(nvm version "$REQUIRED_NODE_VERSION" 2>/dev/null || true)" != "N/A" ] && nvm use --silent "$REQUIRED_NODE_VERSION" >/dev/null 2>&1; then
      NODE_BIN="$(command -v node || true)"
    fi
  fi
fi

if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
    if [ -z "$candidate" ] || [ ! -x "$candidate" ]; then
      continue
    fi
    if matches_required_version "$candidate"; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "Unable to resolve a Node runtime for ClawForce." >&2
  if [ -n "$REQUIRED_NODE_VERSION" ]; then
    echo "Required version from .nvmrc: $REQUIRED_NODE_VERSION" >&2
  fi
  exit 1
fi

if ! matches_required_version "$NODE_BIN"; then
  echo "Resolved Node runtime is incompatible with this ClawForce workspace." >&2
  echo "Resolved: $NODE_BIN ($(node_version "$NODE_BIN" || echo unknown))" >&2
  echo "Required: v$REQUIRED_NODE_VERSION" >&2
  exit 1
fi

exec "$NODE_BIN" "$TARGET" "$@"
