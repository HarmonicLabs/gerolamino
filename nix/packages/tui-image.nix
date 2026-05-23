# `nix build .#tui-image` — OCI container image for the apps/tui Bun node.
{ root, ... }: {
  perSystem = { self', inputs', pkgs, ... }:
    let
      bun = inputs'.bun-overlay.packages.bun;
      tsPackages = self'.packages.ts-packages;
      wasmUtils = self'.packages.wasm-utils;
      wasmPlexer = self'.packages.wasm-plexer;
      lsmWasmShim = root + "/packages/wasm-utils/haskell-lsm/lsm-tree-wasm-shim";
    in {
      packages.tui-image = pkgs.dockerTools.streamLayeredImage {
        name = "gerolamino-tui";
        tag = "latest";

        contents = [
          pkgs.coreutils
          pkgs.cacert
          bun
          (pkgs.linkFarm "tui-app" [
            { name = "app"; path = tsPackages; }
            { name = "wasm/wasm-utils"; path = wasmUtils; }
            { name = "wasm/wasm-plexer"; path = wasmPlexer; }
            { name = "wasm/lsm-tree-wasm-shim"; path = lsmWasmShim; }
          ])
        ];

        config = {
          Entrypoint = [ "${bun}/bin/bun" "run" "/app/apps/tui/src/index.ts" ];
          Cmd = [ "start" "--headless" ];
          Env = [
            "PATH=${bun}/bin:/usr/bin:/bin"
            "WASM_LSM_MODULE_PATH=/wasm/lsm-tree-wasm-shim/lsm-tree-wasm.wasm"
            "WASM_LSM_JSFFI_PATH=/wasm/lsm-tree-wasm-shim/lsm-tree-wasm.js"
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