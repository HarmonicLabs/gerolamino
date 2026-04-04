# Nix app definitions.
# These are runnable with `nix run .#<name>`.
{
  imports = [
    ./download-snapshot.nix
  ];
}
