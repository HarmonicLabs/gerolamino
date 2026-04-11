# snapshot-converter from ouroboros-consensus flake (pinned to pre-Peras commit).
# Converts Mithril snapshots: LMDB → V2LSM.
{ ... }: {
  perSystem = { inputs', ... }: {
    packages.snapshot-converter =
      inputs'.ouroboros-consensus.packages.snapshot-converter;
  };
}
