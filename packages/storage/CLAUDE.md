# storage

Chain storage for the node. Sits over the `BlobStore` service (from `ffi`)
plus a `SqlClient` for metadata. XState has been removed — the ChainDB
lifecycle is now a pure reducer driven by a `SubscriptionRef` +
`Queue<ChainDBEvent>` inside `chain-db-live.ts`.

## Structure

```
src/
  index.ts
  errors.ts                  <- ImmutableDBError, VolatileDBError, LedgerDBError, MempoolError
  types/
    StoredBlock.ts           <- StoredBlock + RealPoint schemas
    LedgerState.ts           <- LedgerStateSnapshot schema
    Mempool.ts               <- MempoolTx, MempoolSnapshot schemas
    ChainUpdate.ts           <- AddBlockResult
    Config.ts                <- StorageConfig
  blob-store/
    service.ts               <- thin re-export of BlobStore/BlobEntry/BlobStoreError from ffi
    keys.ts                  <- 4-byte-prefix key helpers (utxo/blk:/bidx/stak/acct/snap/coff)
    in-memory.ts             <- BlobStoreInMemory — Effect.KeyValueStore-backed layer
    block-analysis.ts        <- analyzeBlockCbor + BlockAnalysis + TxOffset schemas
  operations/
    migrations.ts            <- runMigrations (Effect, idempotent)
    blocks.ts                <- writeImmutableBlock/readImmutableBlock/...volatile/getTip
    snapshots.ts             <- writeSnapshot / readLatestSnapshot
  services/
    immutable-db.ts          <- ImmutableDB service + ImmutableDBLive layer
    volatile-db.ts           <- VolatileDB service + VolatileDBLive layer
    ledger-db.ts             <- LedgerDB service + LedgerDBLive layer
    chain-db.ts              <- ChainDB unified service + ChainDBError + ChainUpdate
    chain-db-live.ts         <- ChainDBLive — reducer + SubscriptionRef + SqlClient + BlobStore
  machines/
    chaindb.ts               <- ChainDBState + pure `reduce(state, event)` transition function
    events.ts                <- ChainDBEvent tagged union (_tag discriminator)
  __tests__/                 <- chain-db, chain-db-sql, sql-integration, chaindb (reducer)
```

## Dependencies

- `effect` ^4.0.0-beta.47 — all services, layers, streams
- `@effect/sql-sqlite-bun` — `SqliteClient` for metadata (TUI + bootstrap)
- `@effect/sql-sqlite-wasm` — browser backend (chrome-ext, future)
- `ffi` — source-of-truth `BlobStore` + `BlobEntry` schema

## Service split (matches Haskell ChainDB)

| Layer         | Purpose                                     | Backing                  |
| ------------- | ------------------------------------------- | ------------------------ |
| `ImmutableDB` | append-only k-deep-stable blocks            | BlobStore + SQL metadata |
| `VolatileDB`  | in-flight blocks within rollback depth      | BlobStore + SQL metadata |
| `LedgerDB`    | snapshot + delta log (UTxO-HD V2LSM)        | BlobStore + SQL metadata |
| `ChainDB`     | unified view (volatile-first, rollback, GC) | composes the above       |

Consumers depend only on the `ChainDB` service tag; the layer composition is
set at the app entrypoint.

## Key Patterns

- **V2LSM-only backend** — Mithril's `snapshot-converter` produces V2LSM
  natively (distribution 2537.0+); no LMDB path is shipped. Alternate
  backends (in-memory, IndexedDB) live under `blob-store/`.
- **`Schema.TaggedErrorClass`** for every error type in `errors.ts`.
- **`Context.Service`** for `ImmutableDB` / `VolatileDB` / `LedgerDB` /
  `ChainDB` — no inline `{ ... } satisfies Service` shapes.
- **`Layer.effect` + explicit env annotation** (`Layer.Layer<S, never,
BlobStore | SqlClient>`) so downstream `tsgo --build` does not widen the
  layer's environment to `any`.
- **XState-free** — the previous `chainDBMachine` parallel-region
  chart collapsed to a pure `reduce(state, event): ChainDBState` fold.
  `ChainDBLive` wires two scoped fibers: a _dispatch_ fiber
  (`Queue<ChainDBEvent> → SubscriptionRef.update(reduce)`) and a _driver_
  fiber (`SubscriptionRef.changes → Stream.changesWith on immutability
region → dispatch promote / gc effects → feed completion events back`).
  Mempool state lives in the Mempool Cluster entity (`packages/consensus`).
- **Effect Stream for range scans** — `ImmutableDB.streamBlocks(from, to)`
  returns `Stream<StoredBlock, ImmutableDBError>` backed by
  `BlobStore.scan(prefix)`.

## Testing

```sh
bunx --bun vitest run packages/storage
```

All tests use `@effect/vitest` (`it.effect` / `it.layer`). The SQL
integration suite (`chain-db-sql.test.ts`, `sql-integration.test.ts`) spins
up an in-memory SQLite via `@effect/sql-sqlite-bun` + a Map-backed
`BlobStore`, runs `runMigrations`, and exercises the full `ChainDBLive`
layer.
