# OCI container image for the Gerolamo bootstrap server.
# Uses bun2nix hook + dockerTools.streamLayeredImage.
#
# The Mithril snapshot (16GB) is NOT baked in — mount it as a volume at /data.
{ inputs, root, ... }: {
  perSystem = { system, lib, self', pkgs, ... }:
    let
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
    in
    {
      packages.bootstrap-app = bootstrapApp;

      packages.bootstrap-image = pkgs.dockerTools.streamLayeredImage {
        name = "ghcr.io/harmoniclabs/bootstrap";
        tag = "latest";
        maxLayers = 80;

        contents = [
          pkgs.bashInteractive
          pkgs.coreutils
          pkgs.cacert
          pkgs.bun
          pkgs.lmdb
          bootstrapApp
        ];

        extraCommands = ''
          mkdir -p tmp data
        '';

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
