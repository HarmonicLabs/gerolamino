{ inputs, ... }: {
  perSystem = { system, lib, ... }:
    let
      pkgs = import inputs.nixpkgs { inherit system; };

      nodeModules = pkgs.stdenv.mkDerivation {
        name = "cbor-schema-node-modules";

        src = ../packages/cbor-schema/package.json;
        dontUnpack = true;

        nativeBuildInputs = [ pkgs.nodejs_latest pkgs.cacert ];

        outputHashAlgo = "sha256";
        outputHashMode = "recursive";
        outputHash = "sha256-vwAWFFXlnuTpBjiUdIZ0YxR5R8PAX242Ehu+yJytARg=";

        SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

        buildPhase = ''
          export HOME=$TMPDIR
          cp $src package.json
          npm install --ignore-scripts
        '';

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
