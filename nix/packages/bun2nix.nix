# bun2nix (re-exported from `nix-community/bun2nix` through our `inputs'`
# wiring so the regen step is `nix run .#bun2nix -- -o bun.nix` rather than
# `nix run github:nix-community/bun2nix -- -o bun.nix` every time.
#
# The flake's `postinstall` script (`package.json:11`) does a PATH probe
# (`command -v bun2nix`) and silently no-ops when the binary isn't on PATH —
# which it isn't inside our `direnv`-loaded devshell. Exposing it as a flake
# package gives us a stable handle for both ad-hoc regen and any future
# automation step (e.g. a pre-commit hook that bails when `bun.nix` is stale).
{ ... }: {
  perSystem = { inputs', ... }: {
    packages.bun2nix = inputs'.bun2nix.packages.bun2nix;
  };
}
