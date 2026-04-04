{ inputs, ... }: {
  perSystem = { system, lib, self', ... }:
    let
      pkgs = import inputs.nixpkgs { inherit system; };

      # Fixed-output derivation: fetch npm dependencies
      # Uses npm (not bun) to get a flat node_modules layout that tsc can resolve
      nodeModules = pkgs.stdenv.mkDerivation {
        name = "miniprotocols-node-modules";

        # Standalone package.json with only npm-published deps (no workspace refs)
        dontUnpack = true;
        buildPhase = ''
          export HOME=$TMPDIR
          cat > package.json <<'PACKAGE'
          ${builtins.toJSON {
            dependencies = {
              "@effect/opentelemetry" = "^4.0.0-beta.38";
              "@harmoniclabs/cbor" = "^1.6.6";
              "@harmoniclabs/obj-utils" = "^1.0.0";
              "@harmoniclabs/uint8array-utils" = "^1.0.4";
              "effect" = "^4.0.0-beta.38";
              "lodash" = "^4.17.23";
            };
            devDependencies = {
              "@types/lodash" = "^4.17.24";
              "typescript" = "^5.9.3";
            };
          }}
          PACKAGE
          npm install --ignore-scripts
        '';

        nativeBuildInputs = [ pkgs.nodejs_latest pkgs.cacert ];

        outputHashAlgo = "sha256";
        outputHashMode = "recursive";
        outputHash = "sha256-kCzjFTBv3+MUKhL3MFYJkvjwTHUc5RFtlIV0NdaDsUE=";

        SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

        installPhase = ''
          cp -r node_modules $out
        '';
      };

      tsconfigLib = pkgs.writeText "tsconfig.lib.json" (builtins.toJSON {
        "extends" = "./tsconfig.json";
        compilerOptions = {
          outDir = "./dist";
          rootDir = "./src";
          declaration = true;
        };
        include = [ "./src/**/*" ];
        exclude = [
          "**/__tests__/**/*"
          "**/*.test.ts"
          "**/*.spec.ts"
          "**/*.bench.ts"
        ];
      });

      src = lib.fileset.toSource {
        root = ../packages/miniprotocols;
        fileset = lib.fileset.unions [
          ../packages/miniprotocols/src
          ../packages/miniprotocols/tsconfig.json
          ../packages/miniprotocols/package.json
        ];
      };
    in
    {
      packages.miniprotocols = pkgs.stdenv.mkDerivation {
        pname = "miniprotocols";
        version = "0.0.5-dev7";
        inherit src;

        nativeBuildInputs = [ pkgs.bun ];

        buildPhase = ''
          # Writable copy of pre-fetched node_modules
          cp -r --no-preserve=mode ${nodeModules} node_modules

          # Inject wasm-plexer build output into node_modules
          rm -rf node_modules/wasm-plexer
          mkdir -p node_modules/wasm-plexer
          cp -r ${self'.packages.wasm-plexer}/* node_modules/wasm-plexer/
          cat > node_modules/wasm-plexer/package.json <<'EOF'
          {"name":"wasm-plexer","version":"0.0.1","main":"wasm_plexer.js","types":"wasm_plexer.d.ts"}
          EOF

          # Provide tsconfig.lib.json
          cp ${tsconfigLib} tsconfig.lib.json

          # Build TypeScript (--build to match Nx behavior)
          bun ./node_modules/typescript/lib/tsc.js --build tsconfig.lib.json
        '';

        installPhase = ''
          cp -r dist $out
        '';
      };
    };
}
