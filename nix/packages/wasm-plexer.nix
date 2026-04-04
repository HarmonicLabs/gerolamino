{ root, ... }: {
  perSystem = { lib, buildWasmPackage, ... }:
    let
      plexerDir = root + "/packages/wasm-plexer";
    in
    {
      packages.wasm-plexer = buildWasmPackage {
        pname = "wasm-plexer";
        version = "0.0.1";
        rustChannel = "stable";
        bindgenTarget = "bundler";
        src = lib.fileset.toSource {
          root = plexerDir;
          fileset = lib.fileset.unions [
            (plexerDir + "/Cargo.toml")
            (plexerDir + "/Cargo.lock")
            (plexerDir + "/src")
          ];
        };
      };
    };
}
