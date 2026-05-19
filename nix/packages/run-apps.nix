# `nix run .#tui-node` — run the TUI app with the in-tree Bun (rpath-
# patched against our nixpkgs's glibc via the bun-overlay re-export in
# `bun.nix`) and the in-tree `liblsm-bridge.so` from `ffi.nix`.
# Avoids the glibc-version skew that bites when running
# `nix run github:0xbigboss/bun-overlay#bun -- ...` against
# haskell.nix-built shared libraries.
#
# Usage (run from the repo root after `bun install`):
#   nix run .#tui-node -- start --headless --snapshot-path ./mithril-snapshot
#
# The wrapper resolves the script path relative to `$PWD` so the live
# workspace's `node_modules` (populated by `bun install`) is on the
# resolver path. Self-contained sandboxing isn't the goal — this is a
# dev/CI convenience.
#
# `bootstrap-server` was deleted along with `apps/bootstrap/` — the
# chrome-ext drag-drop snapshot upload replaces it.
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
      apps.tui-node = mkBunApp {
        name = "tui-node";
        script = "apps/tui/src/index.ts";
        defaultArgs = "start";
      };
    };
}
