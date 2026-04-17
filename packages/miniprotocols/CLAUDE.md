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
    handshake/         <- version negotiation
    chain-sync/        <- block header/tip synchronization (XState machine)
    block-fetch/       <- block body retrieval
    tx-submission/     <- transaction submission
    local-state-query/ <- local node state queries
    local-tx-submit/   <- local transaction submission
    local-tx-monitor/  <- local transaction monitoring
    keep-alive/        <- connection keepalive
    peer-sharing/      <- peer discovery
    local-chain-sync/  <- local chain synchronization
  __tests__/           <- protocol tests + benchmarks
```

Each protocol has: `Client.ts`, `Schemas.ts`, and optionally `Machine.ts`
(XState state machine for ChainSync).

## Dependencies

- `codecs` (workspace) - CBOR encoding
- `wasm-plexer` (workspace) - multiplexer frame encoding/decoding
- `effect` + `@effect/opentelemetry` - async operations + telemetry
- `xstate` ^5.30 - ChainSync state machine
- `@harmoniclabs/ouroboros-miniprotocols-ts` - external protocol types

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
