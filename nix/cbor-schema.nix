{ inputs, ... }: {
  perSystem = { system, lib, ... }:
    let
      pkgs = import inputs.nixpkgs { inherit system; };

      nodeModules = pkgs.stdenv.mkDerivation {
        name = "cbor-schema-node-modules";

        dontUnpack = true;
        buildPhase = ''
          export HOME=$TMPDIR
          cat > package.json <<'PACKAGE'
          ${builtins.toJSON {
            dependencies = {
              "@harmoniclabs/cbor" = "^2.0.1";
              "effect" = "^4.0.0-beta.43";
            };
            devDependencies = {
              "typescript" = "^5.9.3";
            };
          }}
          PACKAGE
          npm install --ignore-scripts
        '';

        nativeBuildInputs = [ pkgs.nodejs_latest pkgs.cacert ];

        outputHashAlgo = "sha256";
        outputHashMode = "recursive";
        outputHash = "sha256-lzzbuXnkFQgNNFVkrxaQoxZpTVPutLcIbJ0T2hCd2Mg=";

        SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

        installPhase = ''
          cp -r node_modules $out
        '';
      };

      tsconfigLib = pkgs.writeText "tsconfig.lib.json" (builtins.toJSON {
        "extends" = "./tsconfig.json";
        compilerOptions = {
          outDir = "./dist";
          rootDir = ".";
          declaration = true;
          noEmit = false;
          verbatimModuleSyntax = false;
          allowImportingTsExtensions = false;
        };
        include = [ "./index.ts" ];
        exclude = [ "**/*.test.ts" "**/*.spec.ts" ];
      });

      src = lib.fileset.toSource {
        root = ../packages/cbor-schema;
        fileset = lib.fileset.unions [
          ../packages/cbor-schema/index.ts
          ../packages/cbor-schema/tsconfig.json
          ../packages/cbor-schema/package.json
        ];
      };
    in
    {
      packages.cbor-schema = pkgs.stdenv.mkDerivation {
        pname = "cbor-schema";
        version = "0.0.1";
        inherit src;

        nativeBuildInputs = [ pkgs.bun ];

        buildPhase = ''
          cp -r --no-preserve=mode ${nodeModules} node_modules
          cp ${tsconfigLib} tsconfig.lib.json
          bun ./node_modules/typescript/lib/tsc.js --build tsconfig.lib.json
        '';

        installPhase = ''
          cp -r dist $out
        '';
      };
    };
}
