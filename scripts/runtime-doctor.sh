#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RUNTIME_WRAPPER="$ROOT_DIR/scripts/with-runtime-node.sh"

echo "ClawForce Runtime Doctor"
echo ""
echo "Workspace:"
echo "  root: $ROOT_DIR"
echo "  .nvmrc: $(tr -d '[:space:]' < "$ROOT_DIR/.nvmrc")"
echo ""

CURRENT_NODE="$(command -v node || true)"
CURRENT_VERSION=""
if [ -n "$CURRENT_NODE" ]; then
  CURRENT_VERSION="$("$CURRENT_NODE" -v)"
  echo "Current shell:"
  echo "  node: $CURRENT_NODE"
  echo "  version: $CURRENT_VERSION"
  echo "  abi: $("$CURRENT_NODE" -p 'process.versions.modules')"
else
  echo "Current shell:"
  echo "  node: not found"
fi
echo ""

echo "Pinned runtime:"
"$RUNTIME_WRAPPER" ./scripts/runtime-info.mjs
echo ""

echo "Native module check:"
CURRENT_STATUS="ok"
if ! node -e "require('better-sqlite3'); console.log('  current-shell: ok')" >/tmp/clawforce-runtime-doctor-current.out 2>/tmp/clawforce-runtime-doctor-current.err; then
  CURRENT_STATUS="fail"
  echo "  current-shell: fail"
  sed 's/^/    /' /tmp/clawforce-runtime-doctor-current.err
else
  cat /tmp/clawforce-runtime-doctor-current.out
fi

if "$RUNTIME_WRAPPER" ./scripts/check-better-sqlite3.mjs >/tmp/clawforce-runtime-doctor-runtime.out 2>/tmp/clawforce-runtime-doctor-runtime.err; then
  cat /tmp/clawforce-runtime-doctor-runtime.out
else
  echo "  pinned-runtime: fail"
  sed 's/^/    /' /tmp/clawforce-runtime-doctor-runtime.err
  exit 1
fi

PINNED_VERSION="$(sed -n '1p' /tmp/clawforce-runtime-doctor-runtime.out | sed -E 's/.*\((v[^,]+),.*/\1/')"

echo ""
if [ "$CURRENT_STATUS" = "fail" ]; then
  echo "Diagnosis:"
  echo "  Shell Node and pinned runtime are out of sync for native addons."
  echo "  Use 'pnpm build', 'pnpm test', and 'pnpm typecheck' from this repo so the wrapper selects the pinned runtime."
elif [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" != "$PINNED_VERSION" ]; then
  echo "Diagnosis:"
  echo "  Shell Node and pinned runtime differ."
  echo "  Native addons currently load in both, but package scripts and the CLI will use the pinned runtime to avoid ABI churn."
else
  echo "Diagnosis:"
  echo "  Shell Node and pinned runtime are aligned for better-sqlite3."
fi
