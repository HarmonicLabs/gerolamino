# Unified TypeScript package build using bun2nix + Nx.
# Builds all TS packages in dependency order via `bunx nx run-many`.
{ inputs, root, ... }: {
  perSystem = { lib, self', pkgs, inputs', ... }:
    let
      bun2nix = inputs'.bun2nix.packages.bun2nix;

      bunDeps = bun2nix.fetchBunDeps {
        bunNix = root + "/bun.nix";
      };

      # Only include what Nx + tsc need — no tests, no db, no .git
      monorepoSrc = lib.fileset.toSource {
        inherit root;
        fileset = lib.fileset.unions [
          # Root config
          (root + "/package.json")
          (root + "/bun.lock")
          (root + "/tsconfig.base.json")
          (root + "/tsconfig.json")
          (root + "/nx.json")

          # TypeScript library packages (source + config)
          (root + "/packages/cbor-schema/src")
          (root + "/packages/cbor-schema/package.json")
          (root + "/packages/cbor-schema/tsconfig.json")
          (root + "/packages/cbor-schema/tsconfig.lib.json")

          (root + "/packages/ledger/src")
          (root + "/packages/ledger/package.json")
          (root + "/packages/ledger/tsconfig.json")
          (root + "/packages/ledger/tsconfig.lib.json")

          (root + "/packages/miniprotocols/src")
          (root + "/packages/miniprotocols/package.json")
          (root + "/packages/miniprotocols/tsconfig.json")
          (root + "/packages/miniprotocols/tsconfig.lib.json")

          (root + "/packages/storage/src")
          (root + "/packages/storage/package.json")
          (root + "/packages/storage/tsconfig.json")
          (root + "/packages/storage/tsconfig.lib.json")

          # Workspace package.json files for Bun workspace resolution
          (root + "/packages/wasm-plexer/package.json")
          (root + "/packages/wasm-plexer/project.json")
          (root + "/packages/wasm-utils/package.json")
          (root + "/packages/bootstrap/package.json")
          (root + "/packages/chrome-ext/package.json")
          (root + "/packages/consensus/package.json")
          (root + "/packages/dashboard/package.json")
          (root + "/packages/lsm-tree/package.json")
          (root + "/apps/bootstrap/package.json")
          (root + "/apps/tui/package.json")
        ];
      };
    in
    {
      packages.ts-packages = pkgs.stdenv.mkDerivation {
        pname = "ts-packages";
        version = "0.1.0";
        src = monorepoSrc;

        nativeBuildInputs = [ pkgs.bun bun2nix.hook ];

        # bun2nix doesn't generate .npm manifest cache files (bun2nix#77),
        # so bun install still needs network access to fetch manifests.
        __noChroot = true;

        inherit bunDeps;
        bunInstallFlags = [ "--backend=copyfile" "--frozen-lockfile" ];

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

          bunx --bun nx run-many \
            --target=build \
            --projects=cbor-schema,ledger,storage,miniprotocols \
            --parallel \
            --skip-nx-cache

          runHook postBuild
        '';

        installPhase = ''
          mkdir -p $out
          for pkg in cbor-schema ledger miniprotocols storage; do
            if [ -d "packages/$pkg/dist" ]; then
              mkdir -p "$out/$pkg"
              cp -r "packages/$pkg/dist" "$out/$pkg/dist"
            fi
          done
        '';
      };

      packages.cbor-schema = pkgs.runCommand "cbor-schema" { } ''
        cp -r ${self'.packages.ts-packages}/cbor-schema/dist $out
      '';

      packages.miniprotocols = pkgs.runCommand "miniprotocols" { } ''
        cp -r ${self'.packages.ts-packages}/miniprotocols/dist $out
      '';

      packages.ledger-pkg = pkgs.runCommand "ledger" { } ''
        cp -r ${self'.packages.ts-packages}/ledger/dist $out
      '';

      packages.storage-pkg = pkgs.runCommand "storage" { } ''
        cp -r ${self'.packages.ts-packages}/storage/dist $out
      '';
    };
}
