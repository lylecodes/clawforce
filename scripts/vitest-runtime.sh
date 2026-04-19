#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RUNNER="$ROOT_DIR/scripts/with-runtime-node.sh"
VITEST="$ROOT_DIR/node_modules/vitest/vitest.mjs"

if [ "$#" -eq 0 ]; then
  exec "$RUNNER" "$VITEST" run
fi

if [ "${1:-}" = "--" ]; then
  shift
fi

exec "$RUNNER" "$VITEST" "$@"
