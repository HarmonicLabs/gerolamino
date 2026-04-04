#!/usr/bin/env bash
# Build IOG's libsodium VRF to WASM using zig cc.
#
# This compiles only the VRF implementation and its dependencies
# (Ed25519, SHA-512, crypto_verify) to a standalone WASM module.
# The result is a ~50-100KB WASM binary exporting VRF functions.

set -euo pipefail

LIBSODIUM_DIR="${LIBSODIUM_DIR:-$HOME/code/reference/libsodium}"
SRC="$LIBSODIUM_DIR/src/libsodium"
OUT_DIR="$(dirname "$0")/pkg"

# Include paths
INCLUDES=(
  -I"$SRC/include"
  -I"$SRC/include/sodium"
  -I"$SRC/include/sodium/private"
  -I"$SRC"
)

# Source files needed for VRF (ietfdraft13 only — what Cardano uses)
SOURCES=(
  # VRF implementation
  "$SRC/crypto_vrf/ietfdraft13/prove.c"
  "$SRC/crypto_vrf/ietfdraft13/verify.c"
  "$SRC/crypto_vrf/ietfdraft13/vrf.c"
  "$SRC/crypto_vrf/crypto_vrf.c"

  # Ed25519 curve operations (VRF dependency)
  "$SRC/crypto_core/ed25519/ref10/ed25519_ref10.c"
  "$SRC/crypto_core/ed25519/core_ed25519.c"
  "$SRC/crypto_core/ed25519/core_h2c.c"

  # SHA-512 (VRF dependency)
  "$SRC/crypto_hash/sha512/cp/hash_sha512_cp.c"
  "$SRC/crypto_hash/sha512/hash_sha512.c"

  # Ed25519 signing (key operations)
  "$SRC/crypto_sign/ed25519/ref10/keypair.c"
  "$SRC/crypto_sign/ed25519/ref10/open.c"
  "$SRC/crypto_sign/ed25519/ref10/sign.c"
  "$SRC/crypto_sign/ed25519/sign_ed25519.c"

  # Constant-time verify
  "$SRC/crypto_verify/sodium/verify.c"

  # Utilities
  "$SRC/sodium/utils.c"
  "$SRC/sodium/runtime.c"

  # Random bytes (stub for WASM — we'll provide our own)
  "$SRC/randombytes/randombytes.c"
)

# Compile flags
FLAGS=(
  -target wasm32-wasi
  -O3
  -DCONFIGURED=1
  -DDEV_MODE=0
  -DHAVE_INLINE_ASM=0
  -DHAVE_TI_MODE=0
  -DHAVE_AMD64_ASM=0
  -DHAVE_WASI=1
  -DNATIVE_LITTLE_ENDIAN=1
  -D__STDC_LIMIT_MACROS
  -D__STDC_CONSTANT_MACROS
  -D_WASI_EMULATED_SIGNAL
  -Wno-unused-function
  -Wno-unknown-pragmas
  -Wno-error=asm-operand-widths
  -fvisibility=default
  -fno-asm
)

# Linker flags — export VRF functions, no entry point
LDFLAGS=(
  -Wl,--no-entry
  -Wl,--export=crypto_vrf_prove
  -Wl,--export=crypto_vrf_verify
  -Wl,--export=crypto_vrf_proof_to_hash
  -Wl,--export=crypto_vrf_keypair
  -Wl,--export=crypto_vrf_seed_keypair
  -Wl,--export=crypto_vrf_sk_to_pk
  -Wl,--export=crypto_vrf_sk_to_seed
  -Wl,--export=crypto_vrf_bytes
  -Wl,--export=crypto_vrf_outputbytes
  -Wl,--export=crypto_vrf_seedbytes
  -Wl,--export=crypto_vrf_publickeybytes
  -Wl,--export=crypto_vrf_secretkeybytes
  -Wl,--export=malloc
  -Wl,--export=free
  -Wl,--strip-all
)

echo "Building VRF WASM with zig cc..."
echo "  libsodium: $LIBSODIUM_DIR"
echo "  sources: ${#SOURCES[@]} files"

zig cc \
  "${FLAGS[@]}" \
  "${INCLUDES[@]}" \
  "${SOURCES[@]}" \
  "${LDFLAGS[@]}" \
  -o "$OUT_DIR/vrf.wasm"

echo "  output: $OUT_DIR/vrf.wasm ($(wc -c < "$OUT_DIR/vrf.wasm") bytes)"

# Optimize with wasm-opt if available
if command -v wasm-opt &>/dev/null; then
  wasm-opt "$OUT_DIR/vrf.wasm" -o "$OUT_DIR/vrf.wasm" -Oz --enable-bulk-memory 2>/dev/null && \
    echo "  optimized: $(wc -c < "$OUT_DIR/vrf.wasm") bytes" || \
    echo "  wasm-opt skipped (bulk-memory not needed)"
fi

echo "Done."
