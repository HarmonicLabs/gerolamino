# chrome-ext

Chrome browser extension for the in-browser Cardano node. Built with Solid.js
and WXT (Web Extension Toolkit).

## Tech Stack

- **UI**: Solid.js ^1.9
- **State**: XState ^5.30
- **Build**: WXT ^0.20 (Web Extension Toolkit)
- **Module**: @wxt-dev/module-solid

## Build

WXT handles the extension build pipeline. Note: WXT's postinstall script fails
in Nix sandbox, so `dontRunLifecycleScripts = true` is set in Nix builds.

## Notes

This is the end-user browser extension that will run the in-browser Cardano
node. It will eventually integrate miniprotocols, ledger, and storage packages.
