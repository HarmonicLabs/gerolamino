{
  description = "Gerolamino: In-browser Cardano node";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    devenv = {
      url = "github:cachix/devenv";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    crane.url = "github:ipetkov/crane";

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    mithril = {
      url = "github:input-output-hk/mithril";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # IOG's libsodium fork with VRF (crypto_vrf_ietfdraft13)
    libsodium-iog = {
      url = "github:input-output-hk/libsodium";
      flake = false;
    };

    mk-shell-bin.url = "github:rrbutani/nix-mk-shell-bin";

    nix2container = {
      url = "github:nlewo/nix2container";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    deploy-rs = {
      url = "github:serokell/deploy-rs";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    flake-root.url = "github:srid/flake-root";

    determinate = {
      url = "https://flakehub.com/f/DeterminateSystems/determinate/3";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.devenv.flakeModule
        inputs.treefmt-nix.flakeModule
        inputs.flake-root.flakeModule
        ./nix
      ];

      # Project root as a Nix path — available in all modules via `config._module.args.root`
      _module.args.root = ./.;
      systems = [ "x86_64-linux" ];
      perSystem = { pkgs, system, config, ... }:
        let
          rustPkgs = import inputs.nixpkgs {
            inherit system;
            overlays = [ inputs.rust-overlay.overlays.default ];
          };
        in
        {
          flake-root.projectRootFile = "flake.nix";
          treefmt = {
            projectRootFile = "flake.nix";
            programs = {
              oxfmt.enable = true;
              nixpkgs-fmt.enable = true;
              rustfmt.enable = true;
              rustfmt.package = rustPkgs.rust-bin.selectLatestNightlyWith
                (toolchain: toolchain.rustfmt);
            };
          };

          devenv = {
            shells.default = {
              devenv.root =
                let
                  envRoot = builtins.getEnv "PWD";
                in
                if envRoot != "" then envRoot else builtins.toString ./.;
              packages = [
                pkgs.lmdb
                pkgs.sqlite
                pkgs.poppler-utils
                pkgs.wasm-pack
                pkgs.binaryen
                config.flake-root.package
              ];

              languages = {
                nix = {
                  enable = true;
                  lsp.enable = true;
                };
                zig = {
                  enable = true;
                  lsp.enable = true;
                };
                rust = {
                  enable = true;
                  channel = "nightly";
                  targets = [ "wasm32-unknown-unknown" ];
                  lsp.enable = true;
                };
                typescript = {
                  enable = true;
                  lsp.enable = true;
                };
                javascript = {
                  enable = true;
                  npm.enable = true;
                  bun.enable = true;
                };
              };

              # --- Process Manager: process-compose with TUI ---
              process.manager.implementation = "process-compose";

              # --- Devenv Tasks ---

              # Download and convert Mithril preprod snapshot to LMDB format.
              # Run manually: devenv tasks run mithril:download-snapshot
              tasks."mithril:download-snapshot" = {
                description = "Download latest Mithril preprod snapshot and convert to LMDB";
                exec = "nix run .#download-snapshot -- \"$DEVENV_STATE/snapshot\"";
                status = ''[ -d "$DEVENV_STATE/snapshot/ledger" ]'';
                showOutput = true;
              };

              # --- Devenv Processes (managed by process-compose TUI) ---

              # Bootstrap server: pull container from GHCR, mount snapshot, serve on :3040.
              # Starts automatically with `devenv up` if snapshot exists.
              processes.bootstrap = {
                exec = ''
                  set -euo pipefail
                  SNAPSHOT_PATH="$DEVENV_STATE/snapshot"

                  if [ ! -d "$SNAPSHOT_PATH/ledger" ]; then
                    echo "No snapshot at $SNAPSHOT_PATH — run: devenv tasks run mithril:download-snapshot"
                    exit 1
                  fi

                  # Pull pre-built container from GHCR (pushed by CI)
                  podman pull ghcr.io/harmoniclabs/bootstrap:latest 2>/dev/null || true

                  # Remove old container if it exists
                  podman rm -f gerolamino-bootstrap 2>/dev/null || true

                  exec podman run \
                    --rm \
                    -p 3040:3040 \
                    -v "$SNAPSHOT_PATH:/data:ro" \
                    --name gerolamino-bootstrap \
                    ghcr.io/harmoniclabs/bootstrap:latest
                '';
                process-compose = {
                  availability = {
                    restart = "on_failure";
                    max_restarts = 3;
                  };
                  readiness_probe = {
                    http_get = {
                      host = "127.0.0.1";
                      port = 3040;
                      path = "/";
                      scheme = "http";
                    };
                    initial_delay_seconds = 5;
                    period_seconds = 10;
                    timeout_seconds = 3;
                    failure_threshold = 5;
                  };
                };
              };

              # --- Helpful Scripts ---
              scripts.download-snapshot = {
                exec = ''
                  devenv tasks run mithril:download-snapshot
                '';
                description = "Download Mithril preprod snapshot (alias)";
              };

              # --- Environment ---
              env.BOOTSTRAP_SERVER_URL = "http://decentralizationmaxi.io:3040";
            };
          };
        };
    };
}
