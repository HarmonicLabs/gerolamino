# Agents - storage

Storage abstraction layer. Backend-agnostic.

- `ChainDBLive` + `LedgerSnapshotStoreLive` compose on `BlobStore` only (no SQL).
- `machines/chaindb.ts` is a pure reducer for immutability transitions (reference).
- Do NOT add backend-specific code here — BlobStore backends live in `wasm-utils/lsm/`.
- Types use Effect Schema. No `as Type`.
