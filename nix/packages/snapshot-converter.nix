# snapshot-converter from ouroboros-consensus flake.
# Converts Mithril snapshots between V1LMDB / V2LSM / InMemory formats.
{ inputs, ... }: {
  perSystem = { system, ... }: {
    packages.snapshot-converter =
      inputs.ouroboros-consensus.packages.${system}.snapshot-converter;
  };
}
