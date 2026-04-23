# miniprotocols

Ouroboros network protocol implementations for Cardano node communication.

## Structure

```
src/
  index.ts
  MiniProtocol.ts      <- protocol enum (Handshake, ChainSync, BlockFetch, etc.)
  Metrics.ts           <- protocol metrics
  multiplexer/         <- protocol multiplexing (uses wasm-plexer)
  protocols/
    index.ts           <- barrel re-exporting each protocol's namespace
    handshake/         <- version negotiation (N2N + N2C)
    chain-sync/        <- block header/tip synchronization
    block-fetch/       <- block body retrieval
    tx-submission/     <- transaction submission (TxSubmission2)
    local-state-query/ <- local node state queries (N2C)
    local-tx-submit/   <- local transaction submission (N2C)
    local-tx-monitor/  <- local transaction monitoring (N2C)
    keep-alive/        <- connection keepalive (cookie-matched RTT)
    peer-sharing/      <- peer discovery (Conway+)
    local-chain-sync/  <- local chain synchronization (N2C)
  __tests__/           <- protocol tests + benchmarks
```

Each protocol directory exposes `Client.ts` (Effect service for outbound
ops) and `Schemas.ts` (tagged-union wire messages). Every protocol is
Effect-native — the XState chain-sync machine that used to live under
`chain-sync/Machine.ts` was an orphaned FSM (Client never used it) and
has been removed.

## Dependencies

- `codecs` (workspace) - CBOR encoding
- `wasm-plexer` (workspace) - multiplexer frame encoding/decoding
- `effect` + `@effect/opentelemetry` - async operations + telemetry
- `@harmoniclabs/ouroboros-miniprotocols-ts` - external protocol types

This package has **no XState dependency** — every protocol client is
built on `Stream` / `Channel` / `PubSub` from Effect v4. XState was retained
only for `packages/storage/src/machines/chaindb.ts` (parallel-region) per
the plan's goal-state.

## Path Aliases

Uses `@/*` aliases in tsconfig.json:

```typescript
import { ... } from "@/protocols/chain-sync/Client.ts";
import { ... } from "@/multiplexer/Multiplexer.ts";
```

## Testing

```sh
bunx --bun vitest run packages/miniprotocols
bunx --bun vitest bench packages/miniprotocols   # network benchmarks
```

Network tests connect to `preprod-node.play.dev.cardano.org:3001`.
