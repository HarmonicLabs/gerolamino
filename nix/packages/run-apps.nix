# `nix run .#tui-node` — run the TUI app with the in-tree Bun (rpath-
# patched against our nixpkgs's glibc via the bun-overlay re-export in
# `bun.nix`).
#
# Usage (run from the repo root after `bun install`):
#   nix run .#tui-node -- start --headless --snapshot-path ./mithril-snapshot
{ ... }: {
  perSystem = { inputs', pkgs, ... }:
    let
      bun = inputs'.bun-overlay.packages.bun;
      mkBunApp = { name, script, defaultArgs ? "" }: {
        type = "app";
        program = toString (pkgs.writeShellScript name ''
          set -eu
          if [ ! -f "$PWD/${script}" ]; then
            echo "error: ${script} not found under \$PWD ($PWD)." >&2
            echo "       Run \`nix run .#${name}\` from the gerolamino repo root." >&2
            exit 1
          fi
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