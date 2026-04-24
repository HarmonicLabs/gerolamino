# Pre-built cardano-node 10.7.1 binary from GitHub releases. Shared by
# `production.nix` (runs `cardano-node`) and `mithril-services.nix`
# (calls `cardano-cli` via CHAIN_OBSERVER_TYPE=cardano-cli). See the
# in-line comment in `production.nix` for the rationale on not using
# haskell.nix.
{ stdenv, fetchurl, autoPatchelfHook, gmp, zlib, ncurses, libsodium, openssl }:
stdenv.mkDerivation {
  pname = "cardano-node";
  version = "10.7.1";
  src = fetchurl {
    url = "https://github.com/IntersectMBO/cardano-node/releases/download/10.7.1/cardano-node-10.7.1-linux-amd64.tar.gz";
    hash = "sha256-5bWBkMWhnRV1/KhPFdpIfiULYdDKZhfjGGrugComsPo=";
  };
  sourceRoot = ".";
  nativeBuildInputs = [ autoPatchelfHook ];
  buildInputs = [ gmp zlib ncurses libsodium openssl ];
  installPhase = ''
    mkdir -p $out/bin
    install -m 755 bin/cardano-node bin/cardano-cli $out/bin/
  '';
}
