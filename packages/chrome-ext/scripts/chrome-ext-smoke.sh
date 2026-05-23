#!/usr/bin/env bash
# Build the extension, run unit tests, and execute Playwright fast + upload projects.
set -euo pipefail
EXT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$EXT"
echo "==> wxt build (development)"
bunx --bun wxt build --mode development
echo "==> vitest (rpc envelope)"
bunx --bun vitest run src/__tests__/rpc-envelope.test.ts
echo "==> playwright fast"
bunx --bun playwright test --project=fast
echo "==> playwright upload (serial, may take several minutes)"
bunx --bun playwright test --project=upload
echo "Smoke complete."
