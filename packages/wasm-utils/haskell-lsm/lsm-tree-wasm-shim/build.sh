#!/usr/bin/env bash
# Build the lsm-tree-wasm reactor module.
#
# Two invariants enforced by `nix shell --ignore-environment`:
#   1. Host x86_64 GHC is NOT on PATH — otherwise the wasm32 TH
#      evaluator picks up host x86_64 .so files (ELF) instead of
#      wasm32 ones (WASM) and fails with
#      `CompileError: expected magic word 00 61 73 6d, found 7f 45 4c 46`.
#   2. The only Haskell toolchain visible is the ghc-wasm-meta
#      `all_9_12` bundle — a known-good triple of GHC 9.12.4 + cabal
#      3.14.2 + wasi-sdk.
#
# Why `all_9_12` and not `all_9_14` (the latest GHC bundle in
# ghc-wasm-meta):
#   * `cborg-0.2.10.0` (latest Hackage) caps `base < 4.22`; GHC 9.14
#     ships base-4.22. `allow-newer: cborg:base` bypasses this.
#   * `safe-wild-cards-1.0.0.2` (pulled in by lsm-tree → fs-api) caps
#     `template-haskell < 2.24`; GHC 9.14 ships template-haskell-2.24.
#     Because `template-haskell` is a non-reinstallable boot package,
#     the resolver enforces this hard — no `allow-newer` escape.
#   * lsm-tree HEAD's `tested-with` stops at GHC 9.12, so upstream
#     hasn't validated 9.14 anyway.
# When either of `cborg` or `safe-wild-cards` lands a base/TH bump on
# Hackage, revisit by swapping `all_9_12` → `all_9_14` here.
#
# See `memory/project_wasm_lsm_tree_session_2_success.md` for the
# original debug trail + `project_wasm_lsm_tree_session_10_toolchain_review.md`
# for the latest-usable verdict (May 2026).
set -euo pipefail

SHIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SHIM_DIR"

nix shell --ignore-environment \
  "gitlab:haskell-wasm/ghc-wasm-meta?host=gitlab.haskell.org#all_9_12" \
  nixpkgs#bash nixpkgs#coreutils nixpkgs#git nixpkgs#cacert \
  nixpkgs#nodejs nixpkgs#findutils \
  --command bash -c '
    set -euo pipefail
    export HOME="${HOME:-/tmp/wasm-build-home}"
    mkdir -p "$HOME"
    wasm32-wasi-cabal build exe:lsm-tree-wasm
    WASM=$(find dist-newstyle -name "lsm-tree-wasm.wasm" | head -1)
    POST_LINK=$(wasm32-wasi-ghc --print-libdir)/post-link.mjs
    node "$POST_LINK" -i "$WASM" -o lsm-tree-wasm.js
    cp "$WASM" lsm-tree-wasm.wasm
    echo "Built lsm-tree-wasm.{wasm,js} — $(stat -c%s lsm-tree-wasm.wasm) bytes"
  '
