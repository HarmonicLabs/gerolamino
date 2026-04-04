{ inputs, ... }: {
  perSystem = { system, pkgs, ... }: {
    packages.libsodium-vrf-wasm = pkgs.stdenvNoCC.mkDerivation {
      pname = "libsodium-vrf-wasm";
      version = "0.1.0";
      src = inputs.libsodium-iog;

      nativeBuildInputs = with pkgs; [ zig binaryen ];

      dontConfigure = true;

      buildPhase = ''
        export HOME=$TMPDIR
        export ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig-cache

        # Provide a dummy main for WASI (the module is a library, not a command)
        echo 'int main(void) { return 0; }' > $TMPDIR/dummy_main.c
        SRC=src/libsodium

        # VRF implementation and its dependencies (Ed25519, SHA-512, crypto_verify)
        SOURCES=(
          $SRC/crypto_vrf/ietfdraft13/prove.c
          $SRC/crypto_vrf/ietfdraft13/verify.c
          $SRC/crypto_vrf/ietfdraft13/vrf.c
          $SRC/crypto_vrf/crypto_vrf.c
          $SRC/crypto_core/ed25519/ref10/ed25519_ref10.c
          $SRC/crypto_core/ed25519/core_ed25519.c
          $SRC/crypto_core/ed25519/core_h2c.c
          $SRC/crypto_hash/sha512/cp/hash_sha512_cp.c
          $SRC/crypto_hash/sha512/hash_sha512.c
          $SRC/crypto_sign/ed25519/ref10/keypair.c
          $SRC/crypto_sign/ed25519/ref10/open.c
          $SRC/crypto_sign/ed25519/ref10/sign.c
          $SRC/crypto_sign/ed25519/sign_ed25519.c
          $SRC/crypto_verify/sodium/verify.c
          $SRC/crypto_hash/sha256/cp/hash_sha256_cp.c
          $SRC/crypto_hash/sha256/hash_sha256.c
          $SRC/sodium/utils.c
          $SRC/sodium/runtime.c
          $SRC/sodium/codecs.c
          $SRC/randombytes/randombytes.c
          $SRC/randombytes/sysrandom/randombytes_sysrandom.c
          $SRC/randombytes/internal/randombytes_internal_random.c
        )

        # Compile with zig cc targeting wasm32-wasi
        # Key flags:
        #   - Do NOT define HAVE_AMD64_ASM or HAVE_INLINE_ASM (they guard x86 asm)
        #   - CONFIGURED=1 skips autotools detection
        #   - _WASI_EMULATED_SIGNAL for wasi-libc signal support
        zig cc \
          -target wasm32-wasi \
          -O3 \
          -I$SRC/include \
          -I$SRC/include/sodium \
          -I$SRC/include/sodium/private \
          -I$SRC \
          -DCONFIGURED=1 \
          -DDEV_MODE=0 \
          -DNATIVE_LITTLE_ENDIAN=1 \
          -D_WASI_EMULATED_SIGNAL \
          -Wno-unused-function \
          -Wno-unknown-pragmas \
          -fvisibility=default \
          "''${SOURCES[@]}" \
          $TMPDIR/dummy_main.c \
          -Wl,--no-entry \
          -Wl,--export=crypto_vrf_prove \
          -Wl,--export=crypto_vrf_verify \
          -Wl,--export=crypto_vrf_proof_to_hash \
          -Wl,--export=crypto_vrf_keypair \
          -Wl,--export=crypto_vrf_seed_keypair \
          -Wl,--export=crypto_vrf_sk_to_pk \
          -Wl,--export=crypto_vrf_sk_to_seed \
          -Wl,--export=crypto_vrf_ietfdraft13_prove \
          -Wl,--export=crypto_vrf_ietfdraft13_verify \
          -Wl,--export=crypto_vrf_ietfdraft13_proof_to_hash \
          -Wl,--export=malloc \
          -Wl,--export=free \
          -Wl,--strip-all \
          -o vrf.wasm

        # Optimize with binaryen
        wasm-opt vrf.wasm -o vrf.wasm -Oz --enable-bulk-memory || true
      '';

      installPhase = ''
        mkdir -p $out
        cp vrf.wasm $out/
      '';
    };
  };
}
