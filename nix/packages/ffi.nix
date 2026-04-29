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
        root = root + "/packages/ffi/haskell/lsm-ffi";
        fileset = root + "/packages/ffi/haskell/lsm-ffi";
      };

      # Zig bridge shared library — wraps Haskell lsm-ffi with buffer-based API.
      # Links against liblsm-ffi.so and provides lsm_bridge_* functions.
      # Built via zig2nix (proper build.zig project instead of raw zig build-lib).
      lsmFfiLib = lsmProject.hsPkgs.lsm-ffi.components.foreignlibs.lsm-ffi;

      # GHC emits ELF version-definition entries (`.gnu.version_d` /
      # `.gnu.version` / `.gnu.version_r`) on its exported FFI symbols.
      # Zig 0.16's bundled ld.lld validates these entries strictly and
      # rejects the GHC encoding with "version definition index 0 ... is
      # out of bounds" for ~190 symbols, breaking the link step.
      #
      # The version metadata is only consulted by the dynamic linker at
      # runtime, and Bun's `dlopen` in `lsm/ffi.ts` looks up unversioned
      # symbols by name — verdef is dead weight for our use case. We
      # rebuild a versionless copy of `liblsm-ffi.so` using a two-stage
      # approach that ld.lld accepts and the runtime dynamic linker can
      # still load:
      #
      #   1. Use `nm` to enumerate every defined dynamic symbol exported
      #      from the original library (these are the names the bridge
      #      wants to call).
      #   2. Use `objcopy --strip-all --strip-unneeded` to strip ALL
      #      symbols, then re-add only the ones we need as global aliases
      #      with no version metadata.
      #
      # In practice the simpler `patchelf --clear-symbol-version` over the
      # full export set achieves the same result without rebuilding —
      # patchelf rewrites the dynamic symbol table to drop the
      # `.gnu.version`/`.gnu.version_d`/`.gnu.version_r` references and
      # the dynamic-linker `DT_VERSYM`/`DT_VERNEED` tags consistently, so
      # the resulting .so is internally coherent (no orphan tags) and
      # unversioned at link time AND runtime.
      lsmFfiLibStripped = pkgs.stdenv.mkDerivation {
        name = "lsm-ffi-stripped";
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.binutils pkgs.patchelf ];
        buildPhase = ''
          mkdir -p $out/lib
          # Find the real (non-symlink) .so file in the source lib dir,
          # copy it, and clear every dynamic symbol's version. Then mirror
          # the SONAME symlinks so consumers that reference
          # `liblsm-ffi.so.0` or `liblsm-ffi.so` resolve correctly.
          for f in ${lsmFfiLib}/lib/liblsm-ffi*; do
            base=$(basename "$f")
            if [ -L "$f" ]; then
              target=$(readlink "$f")
              ln -s "$(basename "$target")" "$out/lib/$base"
            else
              cp "$f" "$out/lib/$base"
              chmod +w "$out/lib/$base"
              # Enumerate every defined dynamic symbol (`-D` = dynamic,
              # `--defined-only` = skip undefined references; type filter
              # `[A-Za-z]` excludes the `U` (undefined) class and `w`
              # (weak undefined)). For each, clear its version binding.
              # Patchelf also rewrites DT_VERSYM/DT_VERNEED dynamic tags
              # so the runtime linker sees a consistent versionless view.
              ${pkgs.binutils}/bin/nm -D --defined-only "$out/lib/$base" \
                | awk '$2 ~ /^[A-Za-z]$/ { print $3 }' \
                | while read sym; do
                    [ -n "$sym" ] && patchelf --clear-symbol-version "$sym" "$out/lib/$base"
                  done
            fi
          done
        '';
        dontInstall = true;
      };

      zigEnv = inputs.zig2nix.outputs.zig-env.${system} {
        nixpkgs = inputs.nixpkgs;
      };
      zigBridge = zigEnv.package {
        src = lib.fileset.toSource {
          root = root + "/packages/ffi/haskell/lsm-ffi/zig-init";
          fileset = root + "/packages/ffi/haskell/lsm-ffi/zig-init";
        };
        pname = "lsm-bridge";
        version = "0.1.0";
        zigBuildFlags = [
          "-Doptimize=ReleaseSafe"
          # Point zig at the version-stripped copy. The original lsmFfiLib
          # still ships at `.#lsm-ffi` for callers that want the unmodified
          # GHC output; only the bridge needs versionless symbols so it
          # links via ld.lld without "version definition index 0 ... is
          # out of bounds" rejections.
          "-Dlsm-ffi-path=${lsmFfiLibStripped}/lib"
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
