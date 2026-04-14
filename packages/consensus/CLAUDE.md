# consensus

Ouroboros Praos consensus layer — header validation, chain selection, nonce
evolution, peer management, and sync pipeline.

## Structure

```
src/
  validate-header.ts   <- 5 parallel Praos assertions (VRF, KES, opcert, stake, leader)
  validate-block.ts    <- Block body hash + size validation
  header-bridge.ts     <- Ledger BlockHeader -> consensus BlockHeader bridge
  chain-selection.ts   <- Praos chain comparison + GSM state
  chain-sync-driver.ts <- N2N ChainSync -> consensus pipeline (RollForward/RollBackward)
  sync.ts              <- Bootstrap sync pipeline (full blocks from ImmutableDB)
  nonce.ts             <- Nonce evolution + epoch nonce derivation
  clock.ts             <- SlotClock service (slot/epoch from wallclock)
  crypto.ts            <- CryptoService (blake2b, ed25519, KES, VRF via WASM)
  consensus-engine.ts  <- ConsensusEngine service (composes validation + selection)
  peer-manager.ts      <- PeerManager service (tip tracking, stall detection)
  node.ts              <- Node orchestrator (status, monitoring loop)
  relay.ts             <- Upstream relay connection (Handshake + ChainSync + KeepAlive)
  util.ts              <- hex, concat, be32 helpers
  __tests__/           <- All tests use @effect/vitest layer() pattern
```

## Dependencies

- `effect` ^4.0.0-beta.47
- `cbor-schema` (CBOR parsing for header extraction)
- `ledger` (block/header decoding)
- `miniprotocols` (N2N protocol clients)
- `storage` (ChainDB, BlobStore)
- `wasm-utils` (ed25519, KES Sum6, VRF, leader threshold math)

## Key Patterns

- **Schema.Struct** for all data types (BlockHeader, LedgerView, PeerState,
  NodeStatus, SyncState, VolatileState)
- **Schema.TaggedClass** for types needing methods (Nonces, SlotConfig, ChainTip)
- **Schema.TaggedErrorClass** for all errors
- **Schema.Literals([...])** for string unions (GsmState, PeerStatus)
- **Context.Service** for all services (CryptoService, ConsensusEngine,
  PeerManager, SlotClock)
- **Effect.all** with concurrency for parallel validation assertions
- **Ref** for atomic mutable state (peer map)
- **Config** for all tunable parameters (stall timeout, KES period, etc.)

## Consensus Assertions (5 parallel)

1. **AssertKnownLeaderVrf** — VRF key matches registered pool
2. **AssertVrfProof** — ECVRF-ED25519-SHA512-Elligator2 proof verification
3. **AssertLeaderStake** — VRF threshold check via pallas-math
4. **AssertKesSignature** — KES Sum6 verify over CBOR(headerBody) + period bounds
5. **AssertOperationalCertificate** — opcert Ed25519 verify + sequence check

## VRF Tagging (Era-Dependent)

- **Babbage+**: Single VRF proof, outputs derived via tagging:
  - Leader: `blake2b-256(0x4c || proofHash)`
  - Nonce: `blake2b-256(0x4e || proofHash)`
- **Pre-Babbage**: Separate leaderVrf and nonceVrf certs with raw outputs

## Testing

```sh
bunx --bun vitest run packages/consensus
```

Tests use `@effect/vitest` `layer()` for service injection. WASM crypto tests
require `nix build .#wasm-utils` first.
