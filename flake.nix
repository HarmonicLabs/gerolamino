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

          # Mithril client + verification keys (for snapshot download task)
          # Tests skipped: upstream reqwest HTTP tests fail in Nix sandbox (no CA certs)
          mithril-client = inputs.mithril.packages.${system}.mithril-client-cli.overrideAttrs (_: {
            doCheck = false;
          });
          mithrilSrc = inputs.mithril;
          mithrilEnv = {
            AGGREGATOR_ENDPOINT = "https://aggregator.release-preprod.api.mithril.network/aggregator";
            GENESIS_VERIFICATION_KEY = builtins.readFile
              "${mithrilSrc}/mithril-infra/configuration/release-preprod/genesis.vkey";
            ANCILLARY_VERIFICATION_KEY = builtins.readFile
              "${mithrilSrc}/mithril-infra/configuration/release-preprod/ancillary.vkey";
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

              # --- Environment ---
              env = {
                LIBLMDB_PATH = "${pkgs.lib.getLib pkgs.lmdb}/lib/liblmdb.so";
                BOOTSTRAP_SERVER_URL = "http://decentralizationmaxi.io:3040";
              };

              # --- Tasks ---

              tasks."mithril:download-snapshot" = {
                description = "Download latest Mithril preprod snapshot and convert to LMDB";
                status = ''[ -d "$DEVENV_STATE/snapshot/ledger" ]'';
                before = [ "devenv:enterShell" ];
                showOutput = true;
                env = mithrilEnv // {
                  PATH = pkgs.lib.makeBinPath [ mithril-client pkgs.coreutils pkgs.jq pkgs.findutils ];
                };
                exec = ''
                  DEST="$DEVENV_STATE/snapshot"
                  WORK="$(mktemp -d)"
                  trap 'rm -rf "$WORK"' EXIT

                  echo "==> Downloading latest Cardano DB snapshot..."
                  mithril-client cardano-db snapshot list --json | jq '.[0]'
                  mithril-client cardano-db download latest --include-ancillary --download-dir "$WORK"

                  SNAP_DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
                  [ -z "$SNAP_DIR" ] && echo "ERROR: No snapshot found" >&2 && exit 1

                  LEDGER_DIR="$(find "$SNAP_DIR/ledger" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)"
                  if [ -d "$LEDGER_DIR" ]; then
                    echo "==> Converting to LMDB format..."
                    mithril-client tools utxo-hd snapshot-converter \
                      --input-dir "$LEDGER_DIR" --output-dir "$LEDGER_DIR"
                  fi

                  mkdir -p "$DEST"
                  rm -rf "''${DEST:?}"/*
                  cp -r "$SNAP_DIR"/* "$DEST/"
                  echo "==> Snapshot installed at $DEST"
                '';
              };

              # --- Processes (managed by process-compose TUI via `devenv up`) ---

              processes.bootstrap = {
                exec = ''
                  export SNAPSHOT_PATH="$DEVENV_STATE/snapshot"
                  exec bun run apps/bootstrap/src/cli.ts serve \
                    --snapshot-path "$SNAPSHOT_PATH"
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

              # --- Containers (OCI images with full devenv shell) ---
              # Build:  devenv container build bootstrap
              # Push:   devenv container copy bootstrap
              # Run:    devenv container run bootstrap

              containers.bootstrap = {
                name = "gerolamino-bootstrap";
                version = "latest";
                startupCommand = "bun run apps/bootstrap/src/cli.ts serve --snapshot-path /data";
                registry = "docker://ghcr.io/harmoniclabs/";
                maxLayers = 20;
                enableLayerDeduplication = true;
              };

              # --- Scripts ---

              scripts.download-snapshot = {
                exec = "devenv tasks run mithril:download-snapshot";
                description = "Download Mithril preprod snapshot";
              };
            };
          };
        };
    };
}
