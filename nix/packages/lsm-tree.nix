# IOG's lsm-tree + our lsm-ffi wrapper built via haskell.nix.
# lsm-tree provides the LSM engine; lsm-ffi wraps it with C-callable exports.
# GHC RTS init is handled explicitly by bridge.zig's init functions.
{ inputs, root, ... }: {
  perSystem = { system, lib, pkgs, ... }:
    let
      haskellNixPkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ inputs.haskellNix.overlays.combined ];
        inherit (inputs.haskellNix) config;
      };

      lsmFfiSrc = lib.fileset.toSource {
        root = root + "/packages/lsm-tree/haskell/lsm-ffi";
        fileset = root + "/packages/lsm-tree/haskell/lsm-ffi";
      };

      # Zig bridge shared library — wraps Haskell lsm-ffi with buffer-based API.
      # Links against liblsm-ffi.so and provides lsm_bridge_* functions.
      # Built via zig2nix (proper build.zig project instead of raw zig build-lib).
      lsmFfiLib = lsmProject.hsPkgs.lsm-ffi.components.foreignlibs.lsm-ffi;
      zigEnv = inputs.zig2nix.outputs.zig-env.${system} {
        nixpkgs = inputs.nixpkgs;
      };
      zigBridge = zigEnv.package {
        src = lib.fileset.toSource {
          root = root + "/packages/lsm-tree/haskell/lsm-ffi/zig-init";
          fileset = root + "/packages/lsm-tree/haskell/lsm-ffi/zig-init";
        };
        pname = "lsm-bridge";
        version = "0.1.0";
        zigBuildFlags = [
          "-Doptimize=ReleaseSafe"
          "-Dlsm-ffi-path=${lsmFfiLib}/lib"
        ];
      };

      # Combine lsm-tree source with our lsm-ffi wrapper into one cabal project.
      combinedSrc = haskellNixPkgs.runCommand "lsm-tree-combined" { } ''
        mkdir -p $out
        cp -r ${inputs.lsm-tree-src}/* $out/
        chmod -R u+w $out
        cp -r ${lsmFfiSrc} $out/lsm-ffi
        chmod -R u+w $out/lsm-ffi
        echo "" >> $out/cabal.project.release
        echo "packages: ./lsm-ffi" >> $out/cabal.project.release
      '';

      lsmProject = haskellNixPkgs.haskell-nix.cabalProject' {
        src = combinedSrc;
        compiler-nix-name = "ghc9123";
        cabalProjectFileName = "cabal.project.release";
        modules = [
          { packages.blockio.flags.serialblockio = true; }
        ];
      };
    in
    {
      packages = {
        # Native lsm-tree library
        lsm-tree-lib = lsmProject.hsPkgs.lsm-tree.components.library;

        # Haskell FFI shared library (C-callable exports)
        lsm-ffi = lsmFfiLib;

        # Zig bridge — wraps lsm-ffi with buffer-based API for Bun
        lsm-bridge = zigBridge;
      };
    };
}
