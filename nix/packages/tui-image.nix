# `nix build .#tui-image` — OCI container image for the apps/tui Bun
# node. Output is a `streamLayeredImage` derivation; the result is an
# executable script that streams the gzipped tarball to stdout (i.e.
# `./result | gzip > tui.oci.tar.gz` or piped directly to `podman load`
# / `docker load`).
#
# Layer composition (dockerTools defaults plus our overrides):
#   1. base coreutils + glibc (from nixpkgs cache-friendly base)
#   2. Bun binary (rpath-patched via bun-overlay)
#   3. WASM artefacts: wasm-utils + wasm-plexer + lsm-tree-wasm-shim
#   4. apps/tui source tree (composed from the bun2nix-built workspace)
#
# Container entrypoint: `bun run /app/apps/tui/src/index.ts start --headless`.
# Runtime config via env vars (RELAY_HOST, GEROLAMINO_SNAPSHOT_PATH,
# GEROLAMINO_DATA_DIR, etc.) per `apps/tui/CLAUDE.md`.
{ ... }: {
  perSystem = { self', inputs', pkgs, ... }:
    let
      bun = inputs'.bun-overlay.packages.bun;
      tsPackages = self'.packages.ts-packages;
      wasmUtils = self'.packages.wasm-utils;
      wasmPlexer = self'.packages.wasm-plexer;
      lsmBridge = self'.packages.lsm-bridge;
      # TODO (per user direction 2026-05-19): switch to the haskell.nix-built
      # lsm-tree-wasm shim once it's exposed as `.#lsm-tree-wasm-shim`.
      # That flips the runtime backend from bun:ffi (lsm-bridge.so) to WASM
      # + Bun:WASI. The Env vars below already set GEROLAMINO_USE_WASM_LSM=1
      # in anticipation; today the WASM_LSM_*_PATH points at the bridge
      # paths and the TUI falls back to bun:ffi.
    in {
      packages.tui-image = pkgs.dockerTools.streamLayeredImage {
        name = "gerolamino-tui";
        tag = "latest";

        # `contents` is a flat list of derivations; dockerTools layers
        # each one. We splice the workspace + WASM artefacts so they
        # are visible at the conventional /app paths.
        contents = [
          pkgs.coreutils
          pkgs.cacert
          bun
          (pkgs.linkFarm "tui-app" [
            { name = "app";              path = tsPackages; }
            { name = "wasm/wasm-utils";  path = wasmUtils; }
            { name = "wasm/wasm-plexer"; path = wasmPlexer; }
            { name = "lib/lsm-bridge";   path = lsmBridge; }
          ])
        ];

        config = {
          Entrypoint = [ "${bun}/bin/bun" "run" "/app/apps/tui/src/index.ts" ];
          Cmd = [ "start" "--headless" ];
          Env = [
            "PATH=${bun}/bin:/usr/bin:/bin"
            # `LIBLSM_BRIDGE_PATH` points at the in-tree lsm-bridge.so
            # (Zig FFI -> Haskell V2LSM) — the current default backend.
            # When the WASM lsm-tree shim lands as `.#lsm-tree-wasm-shim`,
            # add `GEROLAMINO_USE_WASM_LSM=1` + `WASM_LSM_{MODULE,JSFFI}_PATH`
            # here and the runtime switches with no other changes.
            "LIBLSM_BRIDGE_PATH=/lib/lsm-bridge/lib/liblsm-bridge.so"
            "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
          ];
          WorkingDir = "/app";
          ExposedPorts = { "3000/tcp" = { }; };
          Labels = {
            "org.opencontainers.image.title" = "gerolamino-tui";
            "org.opencontainers.image.description" =
              "Gerolamino — Cardano sync-to-tip TUI node (Bun + WASM LSM-tree)";
            "org.opencontainers.image.source" =
              "https://github.com/HarmonicLabs/gerolamino";
          };
        };
      };
    };
}
