# storage

Storage abstraction for blockchain state using XState parallel state machines.

## Structure

```
src/
  index.ts
  types/         <- StoredBlock, LedgerState, Mempool, ChainUpdate, Config
  errors.ts      <- storage error types
  operations/    <- block, snapshot, migration operations
  machines/
    chaindb.ts   <- parallel state machine (blockProcessing, immutability, snapshotting)
    mempool.ts   <- mempool transaction state machine
  __tests__/     <- chaindb.test.ts, mempool.test.ts
```

## Dependencies

- `effect` ^4.0.0-beta.47
- `xstate` ^5.30 - parallel state machines

## Key Patterns

- XState `setup()` with `assign()` and guards for security param checks
- Parallel regions: blockProcessing, immutability, snapshotting run concurrently
- Abstract storage layer - no specific backend (LMDB, IndexedDB, etc.)

## Testing

```sh
bunx --bun vitest run packages/storage
```
