{ root, ... }: {
  perSystem = { lib, buildWasmPackage, ... }:
    let
      utilsDir = root + "/packages/wasm-utils";
    in
    {
      packages.wasm-utils = buildWasmPackage {
        pname = "wasm-utils";
        version = "0.1.0";
        rustChannel = "nightly";
        bindgenTarget = "web";
        optimize = true;
        src = lib.fileset.toSource {
          root = utilsDir;
          fileset = lib.fileset.unions [
            (utilsDir + "/Cargo.toml")
            (utilsDir + "/Cargo.lock")
            (utilsDir + "/src")
            (utilsDir + "/pallas-crypto-patched")
            (utilsDir + "/pallas-math")
            (utilsDir + "/amaru-vrf-dalek")
            (utilsDir + "/amaru-curve25519-dalek")
            (utilsDir + "/.cargo")
          ];
        };
        extraArgs = {
          CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS = "--cfg getrandom_backend=\"wasm_js\"";
        };
      };
    };
}
