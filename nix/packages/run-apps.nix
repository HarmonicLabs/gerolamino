# `nix run .#bootstrap-server` / `nix run .#tui-node` — run the workspace's
# Bun apps with the in-tree Bun (rpath-patched against our nixpkgs's glibc
# via the bun-overlay re-export in `bun.nix`) and the in-tree
# `liblsm-bridge.so` from `ffi.nix`. Avoids the glibc-version skew that
# bites when running `nix run github:0xbigboss/bun-overlay#bun -- ...`
# against haskell.nix-built shared libraries.
#
# Usage (run from the repo root after `bun install`):
#   nix run .#bootstrap-server -- --snapshot-path ./db --network preprod
#   nix run .#tui-node          -- start --headless --bootstrap-url ws://localhost:3040
#
# The wrapper resolves the script path relative to `$PWD` so the live
# workspace's `node_modules` (populated by `bun install`) is on the
# resolver path. Self-contained sandboxing isn't the goal — these apps
# are dev/CI conveniences over the same Bun binary the deployed
# `bootstrap-image.nix` uses, with the lsm-bridge `.so` injected.
{ ... }: {
  perSystem = { self', inputs', pkgs, ... }:
    let
      # Bun re-exported through `inputs'.bun-overlay` so the binary is
      # rpath-patched against the same glibc the lsm-bridge .so expects.
      bun = inputs'.bun-overlay.packages.bun;
      lsmBridge = self'.packages.lsm-bridge;

      mkBunApp = { name, script, defaultArgs ? "" }: {
        type = "app";
        program = toString (pkgs.writeShellScript name ''
          set -eu
          if [ ! -f "$PWD/${script}" ]; then
            echo "error: ${script} not found under \$PWD ($PWD)." >&2
            echo "       Run \`nix run .#${name}\` from the gerolamino repo root." >&2
            exit 1
          fi
          export LIBLSM_BRIDGE_PATH="${lsmBridge}/lib/liblsm-bridge.so"
          exec ${bun}/bin/bun run "$PWD/${script}" ${defaultArgs} "$@"
        '');
      };
    in
    {
      apps.bootstrap-server = mkBunApp {
        name = "bootstrap-server";
        script = "apps/bootstrap/src/cli.ts";
        defaultArgs = "serve";
      };

      apps.tui-node = mkBunApp {
        name = "tui-node";
        script = "apps/tui/src/index.ts";
        defaultArgs = "start";
      };
    };
}
