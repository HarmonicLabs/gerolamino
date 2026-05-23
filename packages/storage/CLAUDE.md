# storage

Chain storage for the node. Sits over the `BlobStore` service (from `ffi`).
**No SQL** — chain metadata, tip pointers, snapshots, and nonces all live
in BlobStore as 4-byte-prefixed key-value entries; the codebase no longer
ships a SQL backend.

## Structure

```
src/
  index.ts
  errors.ts                      <- MempoolError (canonical instance in consensus)
  types/
    StoredBlock.ts               <- StoredBlock + RealPoint schemas
    LedgerState.ts               <- LedgerStateSnapshot schema
    Mempool.ts                   <- MempoolTx, MempoolSnapshot schemas
    ChainUpdate.ts               <- AddBlockResult
    Config.ts                    <- StorageConfig
  blob-store/
    service.ts                   <- thin re-export of BlobStore/BlobEntry/BlobStoreError from ffi
    keys.ts                      <- 4-byte-prefix key helpers (utxo/blk:/bidx/stak/acct/snap/coff)
    chain-keys.ts                <- volatile/immutable meta + by-hash + successor + tip + snapshot keys
    in-memory.ts                 <- BlobStoreInMemory — Effect.KeyValueStore-backed layer
    block-analysis.ts            <- analyzeBlockCbor + BlockAnalysis + TxOffset schemas
  services/
    chain-db.ts                  <- ChainDB service tag + ChainDBError + ChainUpdate (interface only)
    chain-db-live.ts             <- ChainDBLive — BlobStore-only Layer
    ledger-snapshot-store.ts     <- LedgerSnapshotStore tag + Error + BlobStore-only Layer
  machines/
    chaindb.ts                   <- ChainDBState + pure `reduce(state, event)` transition function
    events.ts                    <- ChainDBEvent tagged union (_tag discriminator)
  __tests__/                     <- chain-db, chaindb (reducer)
```

## Dependencies

- `effect` ^4.0.0-beta.47 — all services, layers, streams
- `codecs` (workspace) — `concat`, `be32`, `be64`, `compareBytes` byte primitives
- `lsm-ffi` (workspace) — LSM BlobStore backend on Bun (apps/tui)

## Storage layout

| Prefix | Key shape           | Value shape                    | Purpose                                |
| ------ | ------------------- | ------------------------------ | -------------------------------------- |
| `blk:` | `slot ∥ hash`       | block CBOR (≤ 90 KB)           | Block bytes                            |
| `vmet` | `slot ∥ hash`       | `blockNo ∥ prevHash ∥ size` (44 B) | Volatile block metadata          |
| `imet` | `slot ∥ hash`       | same as `vmet`                 | Immutable block metadata               |
| `vbyh` | `hash`              | `slot` (8 B BE)                | Volatile hash → slot index             |
| `ibyh` | `hash`              | same                           | Immutable hash → slot index            |
| `succ` | `prev ∥ slot ∥ hash`| empty                          | Successor inverted index               |
| `vtip` | (singleton)         | `slot ∥ hash` (40 B)           | Volatile tip pointer                   |
| `itip` | (singleton)         | same                           | Immutable tip pointer                  |
| `snap` | `slot`              | state bytes (≤ 50 MB)          | Ledger-state snapshot                  |
| `smet` | `slot`              | `hash ∥ epoch` (40 B)          | Snapshot metadata                      |
| `nnce` | `epoch`             | `active ∥ evolving ∥ candidate`| Praos nonces                           |

Big-endian slot/epoch encoding means `BlobStore.scan(prefix)` returns
entries in numeric order — `last` of a scan is the highest slot.

## Key patterns

- **BlobStore-only** — every chain operation goes through 4-byte-prefix
  key-value primitives. Range scans drive `streamFrom` and the
  immutability-region promotion path. `BlobStore.putBatch(...)` provides
  atomic multi-key writes (LSM write batch on Bun or browser OPFS LSM).
- **Summary `Ref`** — tip + volatileCount cached in-memory for O(1)
  `getTip` / `getImmutableTip`. Tip pointers are also persisted as
  singleton BlobStore entries (`vtip` / `itip`) so a SW eviction restores
  them on boot via a one-shot scan.
- **Schema.TaggedErrorClass** for every error (`ChainDBError`,
  `LedgerSnapshotError`, `MempoolError`).
- **Context.Service** for `ChainDB` and `LedgerSnapshotStore` — no inline
  `{ ... } satisfies Service` shapes.

## Testing

```sh
bunx --bun vitest run packages/storage
```

All tests use `@effect/vitest` (`it.effect` / `it.layer`). The contract
suite in `chain-db.test.ts` exercises every `ChainDBLive` operation
against `BlobStoreInMemory`.
