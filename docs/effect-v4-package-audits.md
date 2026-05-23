# Effect v4 package audits (pre-subagent wave)

**Date**: 2026-05-19  
**Purpose**: Deep audit of each package *before* spawning Effect v4 polish subagents.
Standards: [`effect-v4-coding-standards.md`](effect-v4-coding-standards.md),
[`cursor-handoff.md`](cursor-handoff.md) §4–§6, [`memory-synthesis.md`](memory-synthesis.md).

Subagents must read **their package section here** + standards doc + grep
`~/code/reference/effect-smol/` for every API they touch.

---

## Wave priority

| Priority | Package | Why |
|----------|---------|-----|
| P0 | `chrome-ext` | Playwright `upload-synthetic` blocker; Rpc/Worker/Atom hot path |
| P1 | `consensus` | Sync driver, EventLog, atoms feed dashboard |
| P1 | `dashboard` | Delta wire + Atom registry contract with hosts |
| P2 | `storage` | ChainDB BlobStore-only path used by offscreen |
| P2 | `miniprotocols` | Relay Socket + mux integration |
| P3 | `wasm-utils` | Rpc Transferable + Worker pool patterns |
| P3 | `ledger` | Schema.suspend Codec fixes, `.match()` exhaustiveness |
| P3 | `codecs` | Foundation; `as unknown as` in mempack memo only |
| P4 | `bootstrap` | Small; FileSystem reader only |
| P4 | `wasm-plexer` | Thin TS glue over WASM |
| P4 | `apps/tui` | Entrypoint layers; mirror chrome-ext atom push |

---

## `packages/codecs`

### Effect surface

- **Core**: `Effect`, `Schema`, `SchemaIssue`, `SchemaTransformation`, `Option`, `BigDecimal`, `Optic`
- **Derive**: `toCodecCbor`, `toCodecMemPack`, composite Links, `SchemaGetter`
- **Tests**: `effect/testing/FastCheck`, `Exit`, `Equal`

### Compliance snapshot

| Check | Status |
|-------|--------|
| `Schema.TaggedErrorClass` errors | ✅ `CborError`, `MemPackError` |
| No `as Type` in src | ⚠️ `toCodecMemPack.ts` `erase`/`reify` use `as unknown as` — documented sound WeakMap erasure; do not spread pattern |
| `Effect.gen` / pipe style | ✅ Derive walkers use gen at boundaries |
| Platform-agnostic | ✅ No platform-bun/browser |
| ES2025 hot path | ✅ `getFloat16`, growable `ArrayBuffer`, `transfer` |

### Hot files

- `src/cbor/derive/{toCodecCbor,compositeLinks,combinators}.ts`
- `src/mempack/derive/{toCodecMemPack,toCodecMemPackBytes}.ts`
- `src/cbor/codec/{encode,decode,CborBytes}.ts`

### Scoped refactor (IN)

- Verify `Schema.decodeUnknownEffect` / codec decode paths against effect-smol `Schema` exports
- Coalesce any `.pipe(x).pipe(y)` chains found in derive (grep)
- Ensure new Links use `Effect.gen` + single pipe, `Schema.TaggedErrorClass` for new errors
- Property tests: keep `FastCheck` + `.toStrictEqual` on bytes

### Scoped refactor (OUT)

- No ledger/consensus coupling
- Do not remove mempack `erase`/`reify` without a Schema-native memo design

### effect-smol grep targets

`Schema.toCodec*`, `SchemaTransformation`, `SchemaIssue`, `AST.toCodec`, `Optic`

### Verify

`vitest run packages/codecs` + `tsgo --noEmit -p packages/codecs/tsconfig.json`

---

## `packages/ledger`

### Effect surface

- **Schema**: `TaggedClass`, `suspend`, `VariantSchema` (`protocol-params.ts`)
- **Decode**: top-level `decode*(cbor): Effect<_, SchemaIssue.Issue>`
- **Tests**: property tests, benches with `Effect.runSync` (bench-only — OK)

### Compliance snapshot

| Check | Status |
|-------|--------|
| `.match()` on MultiEra | ✅ Convention in tests/decoders |
| `Schema.Codec` on suspend | ⚠️ `plutus-data.ts`, `auxiliary-data.ts`, `script.ts` — verify `Schema.Codec<T>` not `Schema.Schema<T>` when touched |
| No platform imports | ✅ |
| Decoder as functions not methods | ✅ |

### Hot files

- `lib/block/block.ts`, `lib/state/new-epoch-state.ts`
- `lib/script/{plutus-data,script}.ts`
- `lib/protocol-params/protocol-params.ts` (VariantSchema)

### Scoped refactor (IN)

- Fix `Schema.suspend` thunks to `Schema.Codec<T>` where still `Schema.Schema<T>`
- Expand `.match()` / `.isAnyOf()` where raw `_tag` chains remain (grep `_tag ===`)
- Align error types with `Schema.TaggedErrorClass` if any plain `Error` remain

### Scoped refactor (OUT)

- Mithril field extraction (treasury/pools) — post-v0.1.0 unless user asks
- No chrome-ext / storage changes

### effect-smol grep targets

`VariantSchema.make`, `Schema.suspend`, `Schema.toArbitrary`, `Schema.decodeUnknownEffect`

### Verify

`vitest run packages/ledger`

---

## `packages/miniprotocols`

### Effect surface

- **Stream/Channel**: all protocol `Client.ts` files
- **Socket**: `effect/unstable/socket/Socket` (import path variants: `/Socket` vs bare)
- **Cluster/Rpc**: `peer/Peer.ts` (`Entity`, `Rpc.make`)
- **Multiplexer**: `Multiplexer.ts` + wasm-plexer
- **Tests**: preprod e2e uses `Effect.runPromise` at script entry (integration script — document if polishing)

### Compliance snapshot

| Check | Status |
|-------|--------|
| No XState | ✅ Machine deleted |
| `Schema.Enum` discriminants | ✅ Handshake/ChainSync schemas |
| `Schedule.both` not `intersect` | Verify grep |
| `console.*` in tests | ⚠️ `preprod-e2e.ts`, `run-all.ts` — integration scripts; migrate diagnostics to `Console.log` if touching |
| `any` in benchmarks | ⚠️ `run-all.ts`, `shared.ts` — bench-only; narrow if refactoring benches |

### Hot files

- `multiplexer/Multiplexer.ts`
- `typed-channel/typed-channel.ts`, `bearer.ts`
- `protocols/chain-sync/Client.ts`, `block-fetch/Client.ts`
- `peer/handler.ts`

### Scoped refactor (IN)

- Normalize Socket import path to `effect/unstable/socket/Socket`
- Audit `Schedule.exponential(...).pipe(Schedule.both(...))` on reconnect paths
- `Fiber.interruptAll` pattern consistency in multiplexer
- Platform-agnostic: keep Bun socket only in `__tests__`

### Scoped refactor (OUT)

- wasm-plexer Rust crate
- No consensus validation changes

### effect-smol grep targets

`Stream.aggregate`, `Schedule.both`, `Socket.layerWebSocketConstructor`, `PubSub.bounded`

### Verify

`vitest run packages/miniprotocols`; optional `VITE_INTEGRATION=1` for relay e2e

---

## `packages/storage`

### Effect surface

- **Layer**: `ChainDBLive`, `LedgerSnapshotStoreLive` via `Layer.effect` + `Effect.gen`
- **Stream**: `Stream.runLast`, `Stream.runCollect`, `Stream.unwrap`, `Stream.flatMap` in `chain-db-live.ts`
- **Persistence**: `KeyValueStore` in `blob-store/in-memory.ts` only
- **XState**: `machines/chaindb.ts` ONLY — pure `reduce(state, event)`

### Compliance snapshot

| Check | Status |
|-------|--------|
| BlobStore-only canonical | ✅ |
| `Schema.TaggedErrorClass` | ✅ `errors.ts` |
| Sequential promote→delete | ✅ Documented invariant |
| `@effect/vitest` in tests | ✅ `chain-db.test.ts` |

### Hot files

- `services/chain-db-live.ts` (largest Effect surface)
- `services/ledger-snapshot-store.ts`
- `machines/{chaindb,events}.ts`

### Scoped refactor (IN)

- Prefer `Stream.last` over collect+index where still present
- Ensure nested gens in `chain-db-live` stay hoisted per handoff §4
- Error `operation` literals exhaustive

### Scoped refactor (OUT)

- Do not add SQL/drizzle paths
- Do not migrate XState machine to Effect (explicitly retained)

### effect-smol grep targets

`Stream.runLast`, `Stream.unwrap`, `Layer.effect`, `KeyValueStore`

### Verify

`vitest run packages/storage`

---

## `packages/bootstrap`

### Effect surface

- **`snapshot.ts`**: `FileSystem`, `Path`, `Schema`, `Effect.gen` for Node/Bun reader
- **`walker.ts`**: browser FS Access (minimal Effect — mostly async JS)
- **Tests**: `@effect/vitest`

### Compliance snapshot

| Check | Status |
|-------|--------|
| No `node:fs` | ✅ Uses Effect FileSystem |
| Layout constants shared | ✅ Used by chrome-ext + TUI |
| Platform in package | ✅ FileSystem from effect; layer provided by apps |

### Hot files

- `snapshot.ts`, `walker.ts`

### Scoped refactor (IN)

- `Effect.catchCause` usage in link/copy — verify idiomatic vs `Effect.catch`
- Align `SnapshotReadError` with `Schema.TaggedErrorClass` if not already
- Single-pipe style in snapshot reader

### Scoped refactor (OUT)

- No apps/bootstrap server (deleted)
- No OPFS upload logic (lives in chrome-ext)

### Verify

`vitest run packages/bootstrap`

---

## `packages/consensus`

### Effect surface

- **Unstable**: `eventlog`, `reactivity/Atom`, `workflow`, `persistence`, `rpc`, `cluster`
- **Core**: `Effect.gen`, `Stream`, `Schedule`, `PubSub`, `Ref`, `Metric`
- **Rpc**: `node-rpc-group.ts`, `validation-rpc-group.ts`, `bun.ts` (`layerProtocolWorker`)
- **Sync**: `relay.ts`, `driver.ts`, `bootstrap.ts`

### Compliance snapshot

| Check | Status |
|-------|--------|
| `Atom.keepAlive` on daemon atoms | ✅ `chain/atoms.ts` |
| `Effect.catch` not `catchAll` | ✅ |
| EventLog not duplicate handlers | Documented in event-log.ts |
| `Effect.runSync` in tests | ⚠️ `peer-manager.test.ts` clock stub — test-only |
| Platform-agnostic package | ✅ Bun layers only in `rpc/bun.ts` |

### Hot files

- `chain/{atoms,event-log}.ts`
- `sync/{relay,driver,bootstrap}.ts`
- `validate/{header,block,apply}.ts`
- `rpc/{node-rpc-group,validation-rpc-group,bun,validation-worker}.ts`
- `peer/manager.ts`

### Scoped refactor (IN)

- `relay.ts` / `storage-lifecycle.ts` — ensure `promoteToImmutable` guards (landed; verify tests)
- Rpc `Transferable` — input `Uint8Array` only, output transferable per memory-synthesis
- Workflow/Activity imports — verify against effect-smol `unstable/workflow`
- Flatten nested pipes in sync driver monitor loops
- `Schedule.both` on relay retry policies

### Scoped refactor (OUT)

- Full validating ledger MVP (UTXOW/fees) — post-v0.1.0
- Cluster/Entity production wiring — scaffold only

### effect-smol grep targets

`EventLog`, `EventJournal`, `Atom.batch`, `Atom.keepAlive`, `Rpc.make`, `Workflow`, `PersistedCache`

### Verify

`vitest run packages/consensus` (build wasm-utils first for crypto tests)

---

## `packages/dashboard`

### Effect surface

- **Atom**: `effect/unstable/reactivity/Atom`, `AtomRegistry`
- **Schema**: `node-state.ts` atom schemas
- **delta.ts**: `buildDeltaJson`, `applyDelta` with `Effect.gen`
- **page.tsx**: `Effect.runSync` for WebView host bridge (TUI entry — acceptable at host boundary)
- **Tests**: `Effect.runPromise` in delta tests — migrate to `it.effect` if polishing tests

### Compliance snapshot

| Check | Status |
|-------|--------|
| No direct platform in components | ✅ PrimitivesProvider |
| `Atom.keepAlive` | ✅ Documented in node-state |
| `console.*` | ⚠️ Check components grep — should be none in src |

### Hot files

- `delta.ts`, `atoms/node-state.ts`, `broadcast.ts`
- `components/Dashboard.tsx` + panels

### Scoped refactor (IN)

- `applyDelta` error channel: `Effect.catch` + `Effect.logWarning` per handoff
- Align `Atom.debounce` signature with effect-smol (`Duration.Input` string, not options object)
- delta.test.ts → `@effect/vitest` if touched
- Document atom keys in delta JSON for host parity (chrome-ext vs TUI)

### Scoped refactor (OUT)

- Solid/Kobalte visual redesign
- chrome-ext host wiring (separate chrome-ext agent unless bug in delta contract)

### effect-smol grep targets

`Atom.make`, `Atom.batch`, `AtomRegistry.make`, `Atom.keepAlive`

### Verify

`vitest run packages/dashboard` + `tsgo` on package

---

## `packages/chrome-ext`

### Effect surface (largest unstable footprint)

| Area | APIs |
|------|------|
| Rpc | `Rpc`, `RpcGroup`, `RpcClient`, `RpcServer`, `RpcSerialization.layerNdjson` |
| Transport | Port (`background/rpc-transport`), BroadcastChannel (`offscreen/rpc-transport`), E2E channel split |
| Workers | `layerProtocolWorker` (crypto), **custom** `layerLsmSingleWorkerProtocol` (lsm) |
| Persistence | `KeyValueStore` → `chrome-key-value-store.ts` |
| Sync | `Socket`, `Layer`, `Metric`, `Effect.forkDetach`, `Fiber.interrupt` |
| Atoms | `AtomRegistry`, `buildDeltaJson`, `Stream.concat` + `PubSub` |
| E2e | `effect-helpers.ts` — `Effect.exit`, `Schedule.spaced`, `Console.log` |

### Compliance snapshot

| Check | Status |
|-------|--------|
| `RpcSerialization.layerNdjson` both BC ends | ✅ Required |
| Single lsm worker | ✅ `__GEROLAMINO_LSM_*` singletons |
| `Effect.forkDetach` at SW/offscreen boot | ✅ |
| `Effect.runFork` at popup entry | ✅ App, SnapshotUpload, dashboard |
| E2E direct BC isolated | ✅ `OFFSCREEN_RPC_E2E_CHANNEL` + clientId 1 (in progress) |
| `console.*` in entrypoints | ❌ forbidden — use `Effect.log` / snapshot-upload-log |
| Playwright upload-synthetic | 🔴 Reopen BlobStoreError / poll timeout — P0 |

### Hot files (refactor order)

1. `entrypoints/offscreen/rpc-transport.ts` — BC routing, clientId map
2. `entrypoints/offscreen/lsm-worker-protocol.ts` — single listener (do not reintroduce `layerProtocolWorker` per-request)
3. `entrypoints/offscreen/main.ts` — RpcServer module load, `forkBootstrapSync`, defer flags
4. `entrypoints/popup/SnapshotUpload.tsx` — e2e vs production upload programs
5. `entrypoints/background/offscreen-rpc-client.ts` — `relayUpload` vs `relayRetry`
6. `e2e/*.spec.ts` — defer bootstrap, direct RPC, session logs

### Scoped refactor (IN)

- Finish E2E BC isolation; verify `rpc-envelope.test.ts` covers e2e channel
- Replace any remaining production-path reliance on SW for upload in Playwright (installE2eDirectOffscreenRpc + defer)
- Audit `Effect.runFork` in Solid components — scope/layer leaks
- `bootstrap-sync.ts`: genesis `LsmReopenAfterUpload` must not race upload (defer + session flag)
- Metrics: `Effect.timed` + `Metric.update` only (no `trackDuration`)
- Entrypoints: grep `Context.Tag` — migrate to `Context.Service` if any remain

### Scoped refactor (OUT)

- Consensus validation rules
- Production zip CI (unless blocking tests)
- Manual harness docs only unless behavior changes

### effect-smol grep targets

`RpcClient.Protocol.make`, `RpcServer.layer`, `RpcSerialization.layerNdjson`, `BrowserWorker.layer`, `Fiber.interrupt`, `Layer.launch`

### Verify

```sh
tsgo --noEmit -p packages/chrome-ext/tsconfig.json
vitest run packages/chrome-ext   # rpc-envelope unit
wxt build --mode development
playwright test --project=fast
playwright test --project=upload
playwright test --project=integration  # needs relay
```

---

## `packages/wasm-utils`

### Effect surface

- **Rpc**: `CryptoRpcGroup`, `layerProtocolWorker` / `RpcServer.layerProtocolWorkerRunner`
- **Loader**: `WasmBytes`, `Effect` init
- **LSM**: `loadLsmModule`, `BlobStore` layers (native + wasm)
- **Errors**: `Schema.TaggedErrorClass`

### Compliance snapshot

| Check | Status |
|-------|--------|
| Transferable on output only | Critical — memory-synthesis |
| `process.env` in tests only | ✅ LSM fixture gates |
| Platform in `rpc/bun.ts` | ✅ App-layer pattern |

### Scoped refactor (IN)

- Audit `Transferable.schema` usage on Rpc payloads (grep)
- Align `CryptoDirect` vs Worker pool docs with effect-smol Worker API
- TS glue only — no cargo in agent scope

### Scoped refactor (OUT)

- Haskell/Rust WASM builds (Nix only)

### Verify

`vitest run packages/wasm-utils` (fixture-gated tests skip without env)

---

## `packages/wasm-plexer`

### Effect surface

- Minimal: `service.ts` property tests with `FastCheck`
- Consumed by miniprotocols — no direct Effect services

### Scoped refactor (IN)

- TS property tests + error types if any Effect usage added
- Document browser vs bun loader paths for miniprotocols consumers

### Scoped refactor (OUT)

- Rust crate

### Verify

`vitest run packages/wasm-plexer`

---

## `apps/tui`

### Effect surface

- **Platform**: `@effect/platform-bun` FileSystem, Socket, WebView
- **Atoms**: mirrors consensus/dashboard push
- **Config**: should use `Config.*` for CLI-derived settings (audit `index.ts`)

### Compliance snapshot

| Check | Status |
|-------|--------|
| Entrypoint-only platform | ✅ |
| `Effect.log` headless annotations | ✅ pattern in handoff |
| Cross-package aliases | ✅ |

### Scoped refactor (IN)

- Grep `process.env` in `src/` — migrate to `Config` + CLI layer
- Align atom push with chrome-ext `buildDeltaJson` contract
- `dashboard/serve.ts` WebView evaluate bridge — Effect boundaries

### Scoped refactor (OUT)

- chrome-ext offscreen architecture

### Verify

`tsgo --noEmit -p apps/tui/tsconfig.json` + `vitest run apps/tui`

---

## Subagent execution contract

Each subagent **must**:

1. Read this package section + [`effect-v4-coding-standards.md`](effect-v4-coding-standards.md)
2. Read `docs/cursor-handoff.md` § for that package + listed memory files
3. Grep `~/code/reference/effect-smol/` for every unstable import changed
4. Stay within **Scoped refactor (IN)**; do not expand scope
5. Return: files changed, effect-smol citations, commands run + pass/fail, deferred items

Do **not** spawn polish until the parent agent confirms P0 chrome-ext Playwright is green if working upload path.
