# IOG's lsm-tree + our lsm-ffi wrapper built via haskell.nix.
# lsm-tree provides the LSM engine; lsm-ffi wraps it with C-callable exports.
# The Zig init code registers GHC RTS init/fini as ELF .init_array/.fini_array.
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

      # Compile Zig init code to a relocatable object file.
      # This .o gets linked into the Haskell foreign-library .so.
      # Compile the C init code using Zig's C compiler (no system GCC needed).
      # Produces a .o with __attribute__((constructor)) that calls hs_init().
      # Compile RTS init using Zig's C compiler.
      zigInitObj = pkgs.runCommand "zig-init-obj"
        {
          nativeBuildInputs = [ pkgs.zig ];
        } ''
        mkdir -p $out
        export ZIG_GLOBAL_CACHE_DIR=$(mktemp -d)
        zig cc -c \
          -target x86_64-linux-gnu \
          -O2 \
          ${lsmFfiSrc}/zig-init/init.c \
          -o $out/zig-init.o
      '';

      # Zig bridge shared library — wraps Haskell lsm-ffi with buffer-based API.
      # Links against liblsm-ffi.so and provides lsm_bridge_* functions.
      lsmFfiLib = lsmProject.hsPkgs.lsm-ffi.components.foreignlibs.lsm-ffi;
      zigBridge = pkgs.runCommand "zig-bridge"
        {
          nativeBuildInputs = [ pkgs.zig ];
        } ''
        mkdir -p $out/lib
        export ZIG_GLOBAL_CACHE_DIR=$(mktemp -d)
        zig build-lib \
          -target x86_64-linux-gnu \
          -OReleaseSafe \
          -dynamic \
          -lc \
          -rpath ${lsmFfiLib}/lib \
          -L${lsmFfiLib}/lib \
          -llsm-ffi \
          ${lsmFfiSrc}/zig-init/bridge.zig \
          -femit-bin=$out/lib/liblsm-bridge.so
      '';

      # Combine lsm-tree source with our lsm-ffi wrapper into one cabal project.
      # The Zig-compiled init.o is placed in lsm-ffi/ so cabal can link it.
      combinedSrc = haskellNixPkgs.runCommand "lsm-tree-combined" { } ''
        mkdir -p $out
        cp -r ${inputs.lsm-tree-src}/* $out/
        chmod -R u+w $out
        cp -r ${lsmFfiSrc} $out/lsm-ffi
        chmod -R u+w $out/lsm-ffi
        # Place the Zig-compiled init object where cabal can find it
        cp ${zigInitObj}/zig-init.o $out/lsm-ffi/zig-init.o
        echo "" >> $out/cabal.project.release
        echo "packages: ./lsm-ffi" >> $out/cabal.project.release
      '';

      lsmProject = haskellNixPkgs.haskell-nix.cabalProject' {
        src = combinedSrc;
        compiler-nix-name = "ghc9123";
        cabalProjectFileName = "cabal.project.release";
        modules = [
          { packages.blockio.flags.serialblockio = true; }
          # Link the Zig-compiled RTS init object into lsm-ffi
          {
            packages.lsm-ffi.components.foreignlibs.lsm-ffi.ghcOptions =
              [ "-optl${zigInitObj}/zig-init.o" ];
          }
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
