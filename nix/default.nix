# Top-level Nix module.
# Imports package derivations and machine configs.
{
  imports = [
    ./packages
    ./machine-configs
  ];
}
