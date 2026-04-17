{
  description = "Gerolamino: In-browser Cardano node";

  nixConfig = {
    extra-substituters = [ "https://cache.iog.io" ];
    extra-trusted-public-keys = [ "hydra.iohk.io:f/Ea+s+dFdN+3Y/G+FDgSq+a5NEWhJGzdjvKNGv0/EQ=" ];
  };

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

    zig2nix = {
      url = "github:Cloudef/zig2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    flake-root.url = "github:srid/flake-root";

    determinate = {
      url = "https://flakehub.com/f/DeterminateSystems/determinate/3";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    bun-overlay = {
      url = "github:0xbigboss/bun-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # IOG's Haskell.nix — handles IOG's tightly coupled dep cluster (CHaP, index-state)
    haskellNix = {
      url = "github:input-output-hk/haskell.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # IOG's LSM tree library
    lsm-tree-src = {
      url = "github:IntersectMBO/lsm-tree";
      flake = false;
    };

    # Ouroboros consensus — pinned to last commit before Peras added 4th element
    # to ShelleyLedgerState. Has V2LSM output AND reads 10.6.2 LMDB (3-element).
    ouroboros-consensus = {
      url = "github:IntersectMBO/ouroboros-consensus/3a59a8a551141a5999f57e86b909bca6d6d6f1ff";
    };

    cardano-node = {
      url = "github:IntersectMBO/cardano-node/10.7.0";
    };
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.devenv.flakeModule
        inputs.treefmt-nix.flakeModule
        inputs.flake-root.flakeModule
        # inputs.haskell-flake.flakeModule  # not used — haskell.nix handles IOG deps
        ./nix
      ];

      # Project root as a Nix path — available in all modules via `config._module.args.root`
      _module.args.root = ./.;
      systems = [ "x86_64-linux" ];
      perSystem = { pkgs, system, config, inputs', ... }:
        # let
        # Mithril client + verification keys (for snapshot download task)
        # Tests skipped: upstream reqwest HTTP tests fail in Nix sandbox (no CA certs)
        # mithril-client = inputs'.mithril.packages.mithril-client-cli.overrideAttrs (_: {
        #   doCheck = false;
        # });
        # mithrilSrc = inputs.mithril;
        # mithrilEnv = {
        #   AGGREGATOR_ENDPOINT = "https://aggregator.release-preprod.api.mithril.network/aggregator";
        #   GENESIS_VERIFICATION_KEY = builtins.readFile
        #     "${mithrilSrc}/mithril-infra/configuration/release-preprod/genesis.vkey";
        #   ANCILLARY_VERIFICATION_KEY = builtins.readFile
        #     "${mithrilSrc}/mithril-infra/configuration/release-preprod/ancillary.vkey";
        # };

        # Ouroboros consensus snapshot-converter (LMDB → V2LSM)
        # snapshot-converter = inputs'.ouroboros-consensus.packages.snapshot-converter;

        # Preprod Cardano config files (for snapshot-converter --config)
        # preprodConfigDir = "${inputs.mithril}/mithril-infra/assets/docker/cardano/config/10.6/preprod/cardano-node";

        # in
        {
          _module.args.pkgs = import inputs.nixpkgs {
            inherit system;
            overlays = with inputs; [
              rust-overlay.overlays.default
              bun-overlay.overlays.default
            ];
          };

          flake-root.projectRootFile = "flake.nix";
          treefmt = {
            projectRootFile = "flake.nix";
            programs = {
              oxfmt.enable = true;
              nixpkgs-fmt.enable = true;
              rustfmt.enable = true;
              rustfmt.package = pkgs.rust-bin.selectLatestNightlyWith
                (toolchain: toolchain.rustfmt);
            };
          };

          devenv = {
            shells.default = {
              devenv.root =
                let
                  envRoot = builtins.getEnv "PWD";
                in
                if envRoot != "" then envRoot else toString ./.;
              packages = [
                pkgs.sqlite
                pkgs.poppler-utils
                pkgs.wasm-pack
                pkgs.binaryen
                # pkgs.chromium
                # mithril-client
                # snapshot-converter
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
                haskell = {
                  enable = true;
                  cabal.enable = true;
                  stack.enable = true;
                  lsp.enable = true;
                };
              };

              # --- Process Manager: process-compose with TUI ---
              process.manager.implementation = "process-compose";

              # --- Environment ---
              env = {
                BOOTSTRAP_SERVER_URL = "http://decentralizationmaxi.io:3040";
                LIBLSM_BRIDGE_PATH = "${config.packages.lsm-bridge}/lib/liblsm-bridge.so";
              };

              # --- Tasks ---

              # Downloads ImmutableDB + ledger state from Mithril.
              # V2LSM conversion requires a synced cardano-node 10.7.x;
              # use CARDANO_NODE_DB to point at an existing V2LSM db.
              # tasks."mithril:download-snapshot" = {
              #   description = "Download Mithril preprod snapshot";
              #   status = ''[ -f "$DEVENV_STATE/snapshot/ledger/"*/state ]'';
              #   showOutput = true;
              #   env = mithrilEnv // {
              #     PATH = pkgs.lib.makeBinPath [
              #       mithril-client
              #       pkgs.coreutils
              #       pkgs.jq
              #       pkgs.findutils
              #     ];
              #   };
              #   exec = ''
              #     DEST="$DEVENV_STATE/snapshot"

              #     # If user provides a V2LSM db from a synced cardano-node, use it directly
              #     if [ -n "''${CARDANO_NODE_DB:-}" ] && [ -d "$CARDANO_NODE_DB/ledger" ]; then
              #       echo "==> Using existing cardano-node db at $CARDANO_NODE_DB"
              #       mkdir -p "$DEST"
              #       rm -rf "''${DEST:?}"/*
              #       cp -r "$CARDANO_NODE_DB"/* "$DEST/"
              #       echo -n "1" > "$DEST/protocolMagicId"
              #       SLOT_DIR="$(find "$DEST/ledger" -maxdepth 1 -type d -regex '.*/[0-9]+' | head -1)"
              #       echo "==> Snapshot installed from cardano-node db (slot $(basename "$SLOT_DIR"))"
              #       exit 0
              #     fi

              #     WORK="$(mktemp -d)"
              #     trap 'rm -rf "$WORK"' EXIT

              #     echo "==> Downloading Mithril preprod snapshot..."
              #     mithril-client cardano-db snapshot list --json | jq '.[0]'
              #     mithril-client cardano-db download latest --include-ancillary --download-dir "$WORK"

              #     SNAP_DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
              #     [ -z "$SNAP_DIR" ] && echo "ERROR: No snapshot found" >&2 && exit 1

              #     echo -n "1" > "$SNAP_DIR/protocolMagicId"

              #     mkdir -p "$DEST"
              #     rm -rf "''${DEST:?}"/*
              #     cp -r "$SNAP_DIR"/* "$DEST/"

              #     SLOT_DIR="$(find "$DEST/ledger" -maxdepth 1 -type d -regex '.*/[0-9]+' | head -1)"
              #     SLOT="$(basename "$SLOT_DIR")"
              #     echo "==> Mithril snapshot installed: slot $SLOT, $(ls "$DEST/immutable/"*.chunk | wc -l) chunks"
              #     echo "    To add V2LSM, set CARDANO_NODE_DB to a synced 10.7.x node's db and re-run"
              #   '';
              # };

              # --- Processes (managed by process-compose TUI via `devenv up`) ---

              # Local cardano-node (preprod, V2LSM).
              # Syncs the full chain — takes 24-48h on first run.
              # Data stored in $DEVENV_STATE/cardano-node/.
              # Config generated from cardanoLib.environments.preprod.
              # processes.cardano-node =
              #   let
              #     cardanoNodePkg = inputs'.cardano-node.packages.cardano-node;
              #     cardanoLib = inputs'.cardano-node.legacyPackages.cardanoLib or
              #       (builtins.throw "cardano-node flake does not expose cardanoLib");
              #     preprodEnv = cardanoLib.environments.preprod;

              #     # Node config with V2LSM enabled
              #     nodeConfigJson = builtins.toJSON (preprodEnv.nodeConfig // {
              #       LedgerDB = {
              #         Backend = "V2LSM";
              #       };
              #     });
              #     configFile = pkgs.writeText "preprod-config.json" nodeConfigJson;
              #     topologyFile = preprodEnv.topology or (pkgs.writeText "preprod-topology.json" (builtins.toJSON {
              #       bootstrapPeers = [
              #         { address = "preprod-node.play.dev.cardano.org"; port = 3001; }
              #       ];
              #       localRoots = [ ];
              #       publicRoots = [{
              #         accessPoints = [
              #           { address = "preprod-node.play.dev.cardano.org"; port = 3001; }
              #         ];
              #         advertise = false;
              #         valency = 1;
              #       }];
              #       useLedgerAfterSlot = -1;
              #     }));
              #   in
              #   {
              #     exec = ''
              #       NODE_DB="$DEVENV_STATE/cardano-node"
              #       mkdir -p "$NODE_DB"

              #       exec ${cardanoNodePkg}/bin/cardano-node run \
              #         --topology ${topologyFile} \
              #         --database-path "$NODE_DB/db" \
              #         --socket-path "$NODE_DB/node.socket" \
              #         --host-addr 0.0.0.0 \
              #         --port 3001 \
              #         --config ${configFile} \
              #         +RTS -N2 -I0 -A16m -RTS
              #     '';
              #     process-compose = {
              #       availability = {
              #         restart = "on_failure";
              #         max_restarts = 3;
              #       };
              #     };
              #   };

              # Bootstrap server — serves from cardano-node db when available,
              # falls back to Mithril snapshot if no node db exists.
              # processes.bootstrap = {
              #   exec = ''
              #     NODE_DB="$DEVENV_STATE/cardano-node/db"
              #     SNAPSHOT_PATH="$DEVENV_STATE/snapshot"

              #     if [ -d "$NODE_DB/ledger" ]; then
              #       echo "==> Starting bootstrap server from cardano-node db"
              #       exec bun run apps/bootstrap/src/cli.ts serve \
              #         --db-path "$NODE_DB" \
              #         --network preprod
              #     elif [ -d "$SNAPSHOT_PATH/ledger" ]; then
              #       echo "==> Starting bootstrap server from Mithril snapshot"
              #       exec bun run apps/bootstrap/src/cli.ts serve \
              #         --snapshot-path "$SNAPSHOT_PATH"
              #     else
              #       echo "==> No data source available. Start cardano-node or run download-snapshot."
              #       sleep infinity
              #     fi
              #   '';
              #   process-compose = {
              #     availability = {
              #       restart = "on_failure";
              #       max_restarts = 3;
              #     };
              #     depends_on.cardano-node.condition = "process_started";
              #     readiness_probe = {
              #       http_get = {
              #         host = "127.0.0.1";
              #         port = 3040;
              #         path = "/";
              #         scheme = "http";
              #       };
              #       initial_delay_seconds = 5;
              #       period_seconds = 10;
              #       timeout_seconds = 3;
              #       failure_threshold = 5;
              #     };
              #   };
              # };

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
            };
          };
        };
    };
}
