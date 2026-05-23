# IOG's lsm-tree + our lsm-ffi Haskell wrapper (for building / dev).
# Runtime BlobStore uses the WASM reactor in `haskell-lsm/lsm-tree-wasm-shim/`,
# not the native Zig bridge (removed May 2026).
{ inputs, root, ... }: {
  perSystem = { system, lib, pkgs, ... }:
    let
      haskellNixPkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ inputs.haskellNix.overlays.combined ];
        inherit (inputs.haskellNix) config;
      };

      lsmFfiSrc = lib.fileset.toSource {
        root = root + "/packages/wasm-utils/haskell-lsm/lsm-ffi";
        fileset = root + "/packages/wasm-utils/haskell-lsm/lsm-ffi";
      };

      lsmFfiLib = lsmProject.hsPkgs.lsm-ffi.components.foreignlibs.lsm-ffi;

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
        lsm-tree-lib = lsmProject.hsPkgs.lsm-tree.components.library;
        lsm-ffi = lsmFfiLib;
      };
    };
}