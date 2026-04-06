# OCI container image for the Gerolamo bootstrap server.
#
# Built with nix2container for fast rebuilds (~1.8s), layer deduplication,
# and direct registry push without tarball I/O.
#
# The Mithril snapshot (16GB) is NOT baked in — mount it as a volume at /data.
#
# Build:  nix build .#bootstrap-image
# Push:   nix run .#bootstrap-image.copyToRegistry -- docker://ghcr.io/harmoniclabs/bootstrap:latest
# Run:    nix run .#bootstrap-image.copyToDockerDaemon && docker run -p 3040:3040 -v /path:/data:ro bootstrap:latest
{ inputs, root, ... }: {
  perSystem = { system, lib, self', pkgs, ... }:
    let
      nix2container = inputs.nix2container.packages.${system}.nix2container;

      bun2nix = inputs.bun2nix.packages.${system}.bun2nix;

      bunDeps = bun2nix.fetchBunDeps {
        bunNix = root + "/bun.nix";
      };

      bootstrapSrc = lib.fileset.toSource {
        inherit root;
        fileset = lib.fileset.unions [
          (root + "/package.json")
          (root + "/bun.lock")
          (root + "/tsconfig.base.json")
          (root + "/tsconfig.json")
          (root + "/nx.json")

          (root + "/apps/bootstrap/src")
          (root + "/apps/bootstrap/package.json")
          (root + "/apps/bootstrap/tsconfig.json")

          (root + "/packages/bootstrap/src")
          (root + "/packages/bootstrap/package.json")
          (root + "/packages/bootstrap/tsconfig.json")

          (root + "/packages/cbor-schema/src")
          (root + "/packages/cbor-schema/package.json")
          (root + "/packages/cbor-schema/tsconfig.json")
          (root + "/packages/cbor-schema/tsconfig.lib.json")

          (root + "/packages/ledger/src")
          (root + "/packages/ledger/package.json")
          (root + "/packages/ledger/tsconfig.json")
          (root + "/packages/ledger/tsconfig.lib.json")

          (root + "/packages/wasm-plexer/package.json")
          (root + "/packages/wasm-plexer/project.json")
          (root + "/packages/wasm-utils/package.json")

          (root + "/packages/miniprotocols/package.json")
          (root + "/packages/storage/package.json")
        ];
      };

      lmdbLib = lib.getLib pkgs.lmdb;

      bootstrapApp = pkgs.stdenv.mkDerivation {
        pname = "bootstrap";
        version = "0.1.0";
        src = bootstrapSrc;

        nativeBuildInputs = [ pkgs.bun bun2nix.hook pkgs.makeWrapper ];

        inherit bunDeps;
        bunInstallFlags = [ "--backend=copyfile" ];

        dontUseBunBuild = true;
        dontRunLifecycleScripts = true;

        postUnpack = ''
          mkdir -p $sourceRoot/packages/wasm-plexer/result
          cp -r ${self'.packages.wasm-plexer}/* $sourceRoot/packages/wasm-plexer/result/

          mkdir -p $sourceRoot/packages/wasm-utils/pkg
          cp -r ${self'.packages.wasm-utils}/* $sourceRoot/packages/wasm-utils/pkg/
        '';

        buildPhase = ''
          runHook preBuild
          runHook postBuild
        '';

        installPhase = ''
          mkdir -p $out/app $out/bin
          cp -r . $out/app/

          makeWrapper ${lib.getExe pkgs.bun} $out/bin/bootstrap \
            --chdir "$out/app" \
            --add-flags "run apps/bootstrap/src/cli.ts serve" \
            --set LIBLMDB_PATH "${lmdbLib}/lib/liblmdb.so"
        '';
      };

      # Layer 1: Stable runtime — bun, LMDB, CA certs, bash, coreutils.
      # Rarely changes, cached across rebuilds.
      runtimeLayer = nix2container.buildLayer {
        deps = [
          pkgs.bun
          pkgs.lmdb
          pkgs.cacert
          pkgs.bashInteractive
          pkgs.coreutils
        ];
      };

      # Layer 2: Application code + node_modules.
      # Changes when source or deps change.
      appLayer = nix2container.buildLayer {
        deps = [ bootstrapApp ];
        layers = [ runtimeLayer ];
      };

      # Writable directories for runtime
      dataDir = pkgs.runCommand "data-dir" { } ''
        mkdir -p $out/tmp $out/data
      '';
    in
    {
      packages.bootstrap-app = bootstrapApp;

      packages.bootstrap-image = nix2container.buildImage {
        name = "ghcr.io/harmoniclabs/bootstrap";
        tag = "latest";

        layers = [
          runtimeLayer
          appLayer
        ];

        copyToRoot = [ dataDir ];

        perms = [{
          path = dataDir;
          regex = ".*";
          mode = "0777";
        }];

        config = {
          Cmd = [
            "${bootstrapApp}/bin/bootstrap"
            "--snapshot-path"
            "/data"
          ];
          Env = [
            "LIBLMDB_PATH=${lmdbLib}/lib/liblmdb.so"
            "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
          ];
          ExposedPorts = { "3040/tcp" = { }; };
          WorkingDir = "/";
        };
      };
    };
}
