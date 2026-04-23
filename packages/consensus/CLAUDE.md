# consensus

Ouroboros Praos consensus layer — header validation, chain selection, nonce
evolution, peer management, and sync pipeline.

## Structure

Topical subdirectories under `src/`:

```
src/
  validate/
    header.ts          <- 5 semantic buckets / 9 failure predicates (VRF + KES)
    block.ts           <- Block body hash + size validation
    apply.ts           <- Effectful block application (produces BlockDiff)
    index.ts
  chain/
    event-log.ts       <- EventLog-backed chain events (ChainEventStream)
    points.ts          <- Fibonacci-offset intersection points
    selection.ts       <- Praos length-first + VRF tiebreak + GSM state
    index.ts
  sync/
    bootstrap.ts       <- Bootstrap sync pipeline (full blocks from ImmutableDB)
    driver.ts          <- N2N ChainSync -> consensus pipeline (RollForward/RollBackward)
    relay.ts           <- Stream-based relay connection (Effect.repeat + Schedule)
    index.ts
  peer/
    manager.ts         <- PeerManager service (tip tracking, stall detection)
    events.ts          <- ConsensusEvents (UI notification PubSub)
    index.ts
  bridges/
    header.ts          <- Ledger BlockHeader -> consensus BlockHeader bridge
    ledger-view.ts     <- Snapshot -> LedgerView + Nonces extraction
    index.ts
  praos/
    clock.ts           <- SlotClock service (slot/epoch from wallclock)
    engine.ts          <- ConsensusEngine service (composes validation + selection)
    nonce.ts           <- Nonce evolution + epoch nonce derivation (yields Crypto)
    index.ts
  hard-fork/
    era-transition.ts  <- EraBoundary + EraHistory + eraAtSlot + crossesEraBoundary
    index.ts
  mempool/             <- Cluster.Singleton-ready mempool + 63 Conway predicates
  rpc/                 <- ValidationRpcGroup (12 methods) + NodeRpcGroup (7 methods)
  stage/               <- SyncStage pipeline primitive
  workflow/            <- BlockSync Workflow + handler layer
  node.ts              <- Node orchestrator (status, monitoring loop)
  observability.ts     <- Metric + SPAN declarations
  util.ts              <- re-exports byte primitives from codecs (single SoT)
  __tests__/           <- All tests use @effect/vitest `it.effect` / `it.layer`
```

The former `machines/` directory was removed in the XState purge (Phase 2 of
the refactor); `sync/relay.ts` is the Stream-based replacement, and the
chain-sync XState machine was orphaned and deleted.

## Dependencies

- `effect` ^4.0.0-beta.47
- `codecs` (CBOR parsing for header extraction)
- `ledger` (block/header decoding)
- `miniprotocols` (N2N protocol clients)
- `storage` (ChainDB, BlobStore)
- `wasm-utils` (ed25519, KES Sum6, VRF, leader threshold math)

## FP discipline

Consensus follows the same rules as `packages/ledger/CLAUDE.md` — they apply
uniformly across every package that doesn't own a hard stdlib / byte-math
boundary.

- **Tagged-union dispatch**: use `Schema.toTaggedUnion(...).match({...})`,
  `.guards[Kind]`, or `.isAnyOf(Kind)` — never raw `switch (x._tag) { ... }`
  or `x._tag === "Foo"` chains when dispatching.
- **Effect-provided `_tag` checks**: `Exit.isSuccess` / `Option.isSome` /
  `Option.match` are the standard helpers. Don't do `exit._tag === "Success"`.
- **`Config.number(...)` unwrapping**: yield inside `Effect.gen(function*
  () { return yield* Config.number(...).pipe(Config.withDefault(...)); }).pipe(Effect.orDie)`.
  Do NOT `Effect.orDie(config)` directly — a Config isn't an Effect until
  yielded.
- **In-memory idempotency indexes**: pair a `KeyValueStore`-backed schema
  store for durability with a `Ref<HashSet<Key>>` for O(1) has/iterate
  (KV has no `keys()`). See `mempool/mempool.ts` for the canonical shape.
- **`.toSorted`/`.toReversed`/`.toSpliced`** over in-place `.sort()` etc.
  when immutability is wanted (almost always).
- **`.reduce` / `Array.from` / `Object.fromEntries`** over manual `let`
  accumulators and `for-of` loops, except inside byte-assembly (comment
  each surviving site).
- **`Effect.as(value)`** over `Effect.gen(function*(){ yield* x; return v; })`
  when the yield is a side effect (e.g. `Effect.log(...)`).
- **`Ref.update(ref, fn)`** takes a pure function; prefer set-arithmetic
  (`new Set([...a, ...b])`, `.difference(b)`, `.union(b)`) over mutation.
- **`RollbackTarget.match({ RealPoint, Origin })`** and every `ChainEvent`,
  `MultiEraBlock`, `SubmitResult`, `HandshakeMessage`, `ChainSyncMessage`
  dispatch goes through its `.match({...})` — consistent across packages.

## Key Patterns

- **Schema.Struct** for all data types (BlockHeader, LedgerView, PeerState,
  NodeStatus, SyncState, VolatileState)
- **Schema.TaggedClass** for types needing methods (Nonces, SlotConfig, ChainTip)
- **Schema.TaggedErrorClass** for all errors
- **Schema.Literals([...])** for string unions (GsmState, PeerStatus)
- **Context.Service** for all services (ConsensusEngine, PeerManager,
  SlotClock). Crypto primitives come from `wasm-utils` (`Crypto` tag +
  `CryptoDirect` / `CryptoWorkerBun` layers).
- **Effect.all** with concurrency for parallel validation assertions
- **Ref** for atomic mutable state (peer map)
- **Config** for all tunable parameters (stall timeout, KES period, etc.)

## Consensus Assertions (5 semantic buckets / 9 Haskell failure predicates)

Per 2026-04-22 wave-2 research against Haskell v10.7.x
(`ouroboros-consensus-protocol/.../Praos.hs:474, :484, :487`):
Haskell actually runs **2** validator functions that together produce
**9** distinct failure constructors. The 5-bucket framing below is a
semantic grouping for dispatch + test matrices, NOT 5 named Assert
constructors.

1. **AssertKnownLeaderVrf** — VRF key matches registered pool (`VRFKeyUnknown`, `VRFKeyWrongVRFKey`)
2. **AssertVrfProof** — ECVRF-ED25519-SHA512-Elligator2 proof verification (`VRFKeyBadProof`)
3. **AssertLeaderStake** — VRF threshold check via pallas-math (`VRFLeaderValueTooBig`)
4. **AssertKesSignature** — KES Sum6 verify + period bounds (`KESBeforeStartOCERT`,
   `KESAfterEndOCERT`, `InvalidKesSignatureOCERT`)
5. **AssertOperationalCertificate** — opcert DSIGN verify + counter range
   (`InvalidSignatureOCERT`, `CounterTooSmallOCERT`, `CounterOverIncrementedOCERT`)

## VRF Tagging (Era-Dependent)

- **Babbage+**: Single VRF proof, outputs derived via tagging:
  - Leader: `blake2b-256(0x4c || proofHash)` — `0x4c` = ASCII `'L'` in Haskell source (`Praos/VRF.hs:108`)
  - Nonce: `blake2b-256(0x4e || proofHash)` — `0x4e` = ASCII `'N'` in Haskell source (`Praos/VRF.hs:109`)
- **Pre-Babbage**: Separate leaderVrf and nonceVrf certs with raw outputs

Tag constants are exported from `wasm-utils` as `vrf_leader_tag()` /
`vrf_nonce_tag()` rather than inline magic bytes.

## Chain selection

`packages/consensus/src/chain/selection.ts` implements **length-first +
VRF-lowest-tiebreak** per Haskell Praos's `comparePraos`
(`ouroboros-consensus-protocol/.../Praos/Common.hs:126-169`). NOT
density-first — density selection belongs to Genesis-mode consensus, not
vanilla Praos. Gerolamino pre-Peras tracks vanilla Praos.

## Hard Fork Combinator

`src/hard-fork/` scaffolds the era-history model used by Phase 3h
dispatch. `EraHistory` is a sorted list of `EraBoundary` records; `eraAtSlot`
resolves which era a block at a given slot validates under (new-era
semantics — the boundary slot itself is in `toEra`, matching Haskell's
`extendToSlot` tick-time translation at `HardFork/Combinator/State.hs:222-336`).
Full state-translation (`translate_{from}_{to}`) is deferred until the
ledger-state per-era layouts land.

## SyncStage

`src/stage/SyncStage.ts` is the typed pipeline primitive: each stage is
`Effect<Out, Err, R>` over an input, wrapped with per-stage `Metric`
counters + latency histogram + `Effect.withSpan` tracing + bounded
concurrency via `Stream.mapEffect({ concurrency })`. Compose with
`connect(stageA, stageB)`. Semantic prior art: Amaru's `pure-stage` Rust
crate, Effect-native translation.

## Chain event log (EventLog-backed)

`src/chain/event-log.ts` emits four durable chain events —
`BlockAccepted` / `RolledBack` / `TipAdvanced` / `EpochBoundary` — directly
through Effect's `EventLog` + `EventJournal` distributed-system primitives
(not a bespoke `PubSub` wrapper). The module exports:

- `writeChainEvent(event)` — `yield*`-able client over `EventLog.write`,
  routed by tag through the declared `ChainEventGroup`.
- `ChainEventStream` — `Context.Service` with `subscribe` / `stream` /
  `history`. A single canonical `EventLog.group` handler fans each decoded
  payload into an internal `PubSub<ChainEventType>` so multiple in-process
  consumers (Mempool rollback reaction, TUI `SubscribeChainEvents` RPC,
  dashboard Atom bridge) see the same ordered stream.
- `ChainEventGroup` / `ChainEventLogSchema` — reusable when a remote
  replica or cross-process observer needs the same event domain.
- `ChainEventsLive` — fully composed layer for tests + dev nodes
  (`EventJournal.layerMemory` + `EventLogEncryption.layerSubtle` +
  generated `EventLog.Identity`). Apps/bootstrap swaps
  `EventJournal.layerMemory` for `SqlEventJournal.layer(...)` at its root.

Because `EventLog.registerHandlerUnsafe` is single-handler-per-event
(`Map.set` overwrites), the internal fan-out `PubSub` is what enables
multi-subscriber live consumption — additional consumers should not
register their own `EventLog.group` handler; they subscribe through
`ChainEventStream`.

Distinct from `peer/events.ts` (`ConsensusEvents`) — that is a coarser UI
notification stream with different retention semantics and no durability.

## Testing

```sh
bunx --bun vitest run packages/consensus
```

Tests use `@effect/vitest` `layer()` for service injection. WASM crypto tests
require `nix build .#wasm-utils` first.
