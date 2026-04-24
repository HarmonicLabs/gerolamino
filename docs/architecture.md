# Gerolamino architecture

One-page map of the node as a distributed system in Effect v4.

## Layer diagram (dependency order)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Leaf Rust → WASM                                                          │
│    wasm-plexer    — Ouroboros multiplexer frame codec                      │
│    wasm-utils     — blake2b tagged, ed25519, KES Sum6, VRF, leader math    │
└────────────────────────────────────────────────────────────────────────────┘
           ↓
┌────────────────────────────────────────────────────────────────────────────┐
│  Foundation (TS, no internal deps)                                         │
│    codecs         — CBOR + MemPack derivation, zero-cost walkers           │
│    ledger         — Byron→Conway block / tx / state decoders, 100% Mithril │
└────────────────────────────────────────────────────────────────────────────┘
           ↓
┌────────────────────────────────────────────────────────────────────────────┐
│  Protocol & storage                                                        │
│    ffi            — Bun FFI over Zig → Haskell V2LSM (BlobStore)           │
│    storage        — ImmutableDB / VolatileDB / LedgerDB / ChainDB          │
│    miniprotocols  — 11 Ouroboros protocols + Effect-native multiplexer     │
│    bootstrap      — WebSocket client for Mithril snapshot replay           │
└────────────────────────────────────────────────────────────────────────────┘
           ↓
┌────────────────────────────────────────────────────────────────────────────┐
│  Consensus (this is where the distributed-system shape lives)              │
│    consensus/stage/            — SyncStage pipeline primitive              │
│    consensus/hard-fork/        — EraBoundary / eraAtSlot / validateHistory │
│    consensus/chain-event-log.ts— durable chain events (PubSub-backed)      │
│    consensus/events.ts         — UI-facing operational notifications       │
│    consensus/validate-header.ts— Praos 5-buckets / 9 failure predicates    │
│    consensus/validate-block.ts — body-hash + size invariants               │
│    consensus/chain-selection.ts— length-first + VRF tiebreak (Praos)       │
│    consensus/chain-sync-driver — N2N ChainSync → SyncStage pipeline        │
│    consensus/nonce.ts          — epoch-nonce evolution                     │
│    consensus/relay.ts          — Effect Stream + Schedule (replaces XState)│
└────────────────────────────────────────────────────────────────────────────┘
           ↓
┌────────────────────────────────────────────────────────────────────────────┐
│  Apps                                                                      │
│    apps/bootstrap — Bun + HttpApi (REST + OpenAPI) + raw WS upgrades       │
│    apps/tui       — Effect CLI + Atom-backed dashboard (WebView upcoming)  │
└────────────────────────────────────────────────────────────────────────────┘
```

## Distributed-system primitive mapping

| Plan primitive | Module | Status |
|---|---|---|
| `SyncStage<In, Out, Err, R>` | `consensus/stage/SyncStage.ts` | Landed ✓ |
| `ChainEventLog` durable-shape events | `consensus/chain-event-log.ts` | Landed ✓ (in-memory PubSub; SqlEventJournal-backed variant deferred) |
| `ConsensusEvents` UI notifications | `consensus/events.ts` | Landed ✓ |
| `EraHistory` + `eraAtSlot` | `consensus/hard-fork/era-transition.ts` | Landed ✓ (scaffold; state-translation deferred) |
| `CryptoRpcGroup` / RPC over BunWorker | `wasm-utils/src/rpc/` | 6-method primitive group landed ✓ |
| `BlobStore` via V2LSM FFI | `ffi/src/lsm/` | Landed ✓ |
| `ChainDB` (XState parallel-region over BlobStore + SqlClient) | `storage/src/services/chain-db-live.ts` | Landed ✓ |
| `Mempool Cluster Entity` | `consensus/mempool/` | Deferred (63-predicate Conway UTXOW) |
| `BlockSync Workflow` | `consensus/workflow/` | Deferred (composes peer + ChainDb + stages) |
| `PeerRegistry` + Peer Cluster Entity | `miniprotocols/src/peer/` | Deferred |
| `HttpApi` REST (apps/bootstrap) | `apps/bootstrap/src/http-api.ts` | Landed ✓ (peers/mempool endpoints stubbed) |
| `NodeRpcGroup` main-thread ↔ node-worker | `consensus/src/rpc/node-*.ts` | Deferred (couples w/ Phase 5 Bun.WebView) |
| `AtomRegistry` UI state bridge | `packages/dashboard/src/atoms/` | Landed ✓ (Solid primitives) |
| `OpenTelemetry` OTLP export | `apps/bootstrap/src/otlp-layer.ts` | Deferred |
| `Workflow` durable block-sync | `consensus/workflow/block-sync.ts` | Deferred |

## XState scope

XState is retained in **exactly one file**: `packages/storage/src/machines/chaindb.ts`.
That machine runs two parallel regions (block processing + immutability
promotion) concurrently — a genuine parallel-actor case that `Stream` /
`Effect.forEach` patterns cannot express cleanly. All other XState machines
were removed:
- `packages/miniprotocols/src/protocols/chain-sync/Machine.ts` — orphaned,
  Client was already Effect-native.
- `packages/consensus/src/machines/relay.ts` — replaced by Stream-based
  `packages/consensus/src/relay.ts`.

## Layer composition

`apps/bootstrap/src/cli.ts` and `apps/tui/src/index.ts` each compose the
full layer stack at the process entrypoint. No Layer construction happens
inside library packages — they export Layers and let apps wire.

Typical composition:
```ts
const AppLive = Layer.mergeAll(
  // Platform
  BunFileSystem.layer,
  BunPath.layer,
  // Storage
  LsmLive,                // ffi/BlobStore
  SqliteClient.layer(...),
  ChainDbLive,            // storage + in-place XState actor
  // Consensus
  ChainEventLog.Live,
  ConsensusEngineWithWorkerCrypto,   // includes CryptoWorkerBun
  SlotClockLive,
  PeerManagerLive,
  // HTTP / CLI
  apiRouter.pipe(Layer.provide(BunHttpServer.layer(...))),
)
```

## Testing strategy

- Unit tests via `@effect/vitest` `it.effect` / `it.layer` / `it.prop`;
  bare `vitest` only for schema-round-trip or benchmark harnesses.
- Property tests required on: codec round-trips, era-history invariants,
  chain-event-log fan-out, consensus rule predicates.
- Integration tests: `packages/miniprotocols/src/__tests__/preprod.test.ts`
  (gated on `VITE_INTEGRATION=1`) connects to a real preprod relay.
- Total: 741 passing / 9 skipped (as of this document's commit).

## Non-goals

- **Cross-process cluster** — `HttpRunner` / `SocketRunner` deferred until
  a second-process consumer actually needs them.
- **Peras finality** — consensus pinned pre-Peras until the upstream
  protocol stabilizes.
- **Full Conway governance state machines** (EPOCH tally, treasury
  withdrawals) — ledger has the types; rules are later wave.
- **Chrome-ext UI rebuild** — ripe only once core is frozen.
