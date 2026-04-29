/**
 * Effect Atoms for node state — shared reactive state consumed by
 * both `apps/tui` (Bun.WebView) and `packages/chrome-ext` (WXT popup).
 *
 * Atoms are framework-agnostic. UI frameworks consume via `@effect/atom-solid`
 * hooks (`useAtomValue`, `useAtom`); each host provides its own
 * `AtomRegistry` Layer + push pipeline (TUI: in-memory + Bun.WebView delta
 * batching; chrome-ext: SyncStateRef → chrome.storage.session → StorageBridge).
 */
import * as AtomRegistryModule from "effect/unstable/reactivity/AtomRegistry";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as Schema from "effect/Schema";
import { takeRight } from "es-toolkit";

// ---------------------------------------------------------------------------
// Node status
// ---------------------------------------------------------------------------

export const SyncStatus = Schema.Literals([
  "idle",
  "connecting",
  "bootstrapping",
  "syncing",
  "caught-up",
  "error",
] as const);
export type SyncStatus = typeof SyncStatus.Type;

export const GsmState = Schema.Literals(["Syncing", "CaughtUp", "PreSyncing"] as const);
export type GsmState = typeof GsmState.Type;

export const NodeState = Schema.Struct({
  status: SyncStatus,
  tipSlot: Schema.BigInt,
  tipBlockNo: Schema.BigInt,
  currentSlot: Schema.BigInt,
  epochNumber: Schema.BigInt,
  gsmState: GsmState,
  syncPercent: Schema.Number,
  blocksProcessed: Schema.Number,
  lastError: Schema.optionalKey(Schema.String),
  lastUpdated: Schema.Number,
});
export type NodeState = typeof NodeState.Type;

export const INITIAL_NODE_STATE: NodeState = {
  status: "idle",
  tipSlot: 0n,
  tipBlockNo: 0n,
  currentSlot: 0n,
  epochNumber: 0n,
  gsmState: "PreSyncing",
  syncPercent: 0,
  blocksProcessed: 0,
  lastUpdated: 0,
};

// All writable atoms below are wrapped in `Atom.keepAlive` so the
// `AtomRegistry` does NOT auto-dispose their nodes between non-subscribed
// reads. The TUI delta-push fiber and the headless log fiber both use
// `registry.get(atom)` (one-shot, no subscription); without keepAlive,
// node-removal can sweep the value before the next reader sees the latest
// write. Mirrors `consensus/chain/atoms.ts:55-75` precedent — cf.
// `effect/unstable/reactivity/Atom.ts:1486-1494` and
// `AtomRegistry.ts:421` `scheduleAtomRemoval`.

/** Writable atom for the node's sync/consensus state. */
export const nodeStateAtom: Atom.Writable<NodeState> = Atom.keepAlive(
  Atom.make(INITIAL_NODE_STATE),
);

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

/**
 * Peer status enum. MUST stay byte-identical to `consensus/peer/manager.ts`
 * `PeerStatus` — that's the single wire-canonical source (re-exported as
 * `PeerInfoStatus` from `consensus/rpc` for RPC consumers). Dashboard keeps
 * a local copy to stay decoupled from consensus's type-check graph (dashboard
 * is a leaf UI package with no other workspace deps beyond solid-js +
 * es-toolkit). If a new peer status lands in consensus, this literal set
 * must be updated in lockstep or NodeRpc decodes will schema-error at the UI.
 */
export const PeerInfoStatus = Schema.Literals([
  "connecting",
  "syncing",
  "synced",
  "stalled",
  "disconnected",
]);
export type PeerInfoStatus = typeof PeerInfoStatus.Type;

export const PeerInfo = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  status: PeerInfoStatus,
  tipSlot: Schema.optional(Schema.BigInt),
  latencyMs: Schema.optionalKey(Schema.Number),
});
export type PeerInfo = typeof PeerInfo.Type;

/** Writable atom for the peer list. */
export const peersAtom: Atom.Writable<readonly PeerInfo[]> = Atom.keepAlive(
  Atom.make<readonly PeerInfo[]>([]),
);

// ---------------------------------------------------------------------------
// Bootstrap progress
// ---------------------------------------------------------------------------

export const BootstrapPhase = Schema.Literals([
  "idle",
  "awaiting-init",
  "awaiting-ledger-state",
  "decoding-ledger-state",
  "writing-accounts",
  "receiving-utxos",
  "receiving-blocks",
  "writing-stake",
  "complete",
]);
export type BootstrapPhase = typeof BootstrapPhase.Type;

export const BootstrapProgress = Schema.Struct({
  phase: BootstrapPhase,
  protocolMagic: Schema.Number,
  totalChunks: Schema.Number,
  totalBlobEntries: Schema.Number,
  snapshotSlot: Schema.String,
  blobEntriesReceived: Schema.Number,
  blocksReceived: Schema.Number,
  ledgerStateReceived: Schema.Boolean,
  ledgerStateDecoded: Schema.Boolean,
  accountsWritten: Schema.Number,
  totalAccounts: Schema.optionalKey(Schema.Number),
  stakeEntriesWritten: Schema.Number,
  totalStakeEntries: Schema.optionalKey(Schema.Number),
});
export type BootstrapProgress = typeof BootstrapProgress.Type;

export const INITIAL_BOOTSTRAP: BootstrapProgress = {
  phase: "idle",
  protocolMagic: 0,
  totalChunks: 0,
  totalBlobEntries: 0,
  snapshotSlot: "0",
  blobEntriesReceived: 0,
  blocksReceived: 0,
  ledgerStateReceived: false,
  ledgerStateDecoded: false,
  accountsWritten: 0,
  stakeEntriesWritten: 0,
};

/** Writable atom for bootstrap progress. */
export const bootstrapAtom: Atom.Writable<BootstrapProgress> = Atom.keepAlive(
  Atom.make(INITIAL_BOOTSTRAP),
);

// ---------------------------------------------------------------------------
// Network info
// ---------------------------------------------------------------------------

export const NetworkName = Schema.Literals(["preprod", "mainnet", "preview"]);
export type NetworkName = typeof NetworkName.Type;

export const NetworkInfo = Schema.Struct({
  network: NetworkName,
  protocolMagic: Schema.Number,
  relayHost: Schema.String,
  relayPort: Schema.Number,
});
export type NetworkInfo = typeof NetworkInfo.Type;

export const INITIAL_NETWORK: NetworkInfo = {
  network: "preprod",
  protocolMagic: 1,
  relayHost: "",
  relayPort: 3001,
};

/** Writable atom for network configuration. */
export const networkInfoAtom: Atom.Writable<NetworkInfo> = Atom.keepAlive(
  Atom.make(INITIAL_NETWORK),
);

// ---------------------------------------------------------------------------
// Derived atoms (read-only)
// ---------------------------------------------------------------------------

/** Derived: slots behind tip. Clamped to `0n` because during initialization
 *  `tipSlot` may briefly exceed `currentSlot` before the wallclock catches up,
 *  and a negative "behind" counter would render incoherently. */
export const slotsBehindAtom: Atom.Atom<bigint> = Atom.make((get) => {
  const state = get(nodeStateAtom);
  const behind = state.currentSlot - state.tipSlot;
  return behind < 0n ? 0n : behind;
});

/** Derived: human-readable sync percentage string. */
export const syncPercentLabelAtom: Atom.Atom<string> = Atom.make((get) => {
  const state = get(nodeStateAtom);
  if (state.status === "caught-up") return "100%";
  if (state.status === "idle") return "--";
  return `${Math.min(state.syncPercent, 100).toFixed(1)}%`;
});

// ---------------------------------------------------------------------------
// Mempool snapshot
// ---------------------------------------------------------------------------

/**
 * One row in the mempool snapshot. The `txIdHex` is the canonical UI key
 * (32-byte tx hash hex) — passed through TanStack Table's `getRowId` so
 * row identity is stable as txs enter/leave the pool, which keeps
 * virtualizer scroll position from snapping on append.
 */
export const MempoolEntry = Schema.Struct({
  txIdHex: Schema.String,
  sizeBytes: Schema.Number,
  feePerByte: Schema.Number,
  addedSlot: Schema.BigInt,
});
export type MempoolEntry = typeof MempoolEntry.Type;

/** Writable atom for the latest mempool snapshot, ordered as the producer
 *  emitted (consensus emits feePerByte-desc; UI sort can re-key locally). */
export const mempoolSnapshotAtom: Atom.Writable<readonly MempoolEntry[]> = Atom.keepAlive(
  Atom.make<readonly MempoolEntry[]>([]),
);

/** Derived: pending tx count. */
export const mempoolSizeAtom: Atom.Atom<number> = Atom.make(
  (get) => get(mempoolSnapshotAtom).length,
);

/** Derived: median feePerByte across the snapshot, 0 when empty. The `?? 0`
 *  fallbacks below are unreachable (`mid` is computed from `fees.length` so
 *  both indices are in range) but satisfy `noUncheckedIndexedAccess`. */
export const mempoolFeeP50Atom: Atom.Atom<number> = Atom.make((get) => {
  const snap = get(mempoolSnapshotAtom);
  if (snap.length === 0) return 0;
  const fees = snap.map((e) => e.feePerByte).toSorted((a, b) => a - b);
  const mid = fees.length >> 1;
  return fees.length % 2 === 0 ? ((fees[mid - 1] ?? 0) + (fees[mid] ?? 0)) / 2 : (fees[mid] ?? 0);
});

// ---------------------------------------------------------------------------
// Chain event log (bounded ring buffer)
// ---------------------------------------------------------------------------

/**
 * Tagged union of chain-lifecycle events. Mirrors
 * `consensus/chain/event-log.ts::ChainEvent` byte-for-byte at the schema
 * level so the chrome-ext popup `StorageBridge` can route a server-side
 * tagged value into this atom without re-tagging.
 */
export const ChainEventEntry = Schema.Union([
  Schema.TaggedStruct("BlockAccepted", {
    slot: Schema.BigInt,
    blockNo: Schema.BigInt,
    hash: Schema.Uint8Array,
    parentHash: Schema.Uint8Array,
  }),
  Schema.TaggedStruct("RolledBack", {
    /** New tip after rollback — RealPoint or origin sentinel. */
    to: Schema.Union([
      Schema.TaggedStruct("RealPoint", {
        slot: Schema.BigInt,
        hash: Schema.Uint8Array,
      }),
      Schema.TaggedStruct("Origin", {}),
    ]).pipe(Schema.toTaggedUnion("_tag")),
    depth: Schema.Number,
  }),
  Schema.TaggedStruct("TipAdvanced", {
    slot: Schema.BigInt,
    blockNo: Schema.BigInt,
    hash: Schema.Uint8Array,
  }),
  Schema.TaggedStruct("EpochBoundary", {
    fromEpoch: Schema.BigInt,
    toEpoch: Schema.BigInt,
    epochNonce: Schema.Uint8Array,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type ChainEventEntry = typeof ChainEventEntry.Type;

/** UI-side cap on the bounded ring; producer-side caps lower (256) so the
 *  UI's defensive limit never bites under correct producer behaviour. */
export const CHAIN_EVENT_LOG_CAP = 1000;

/** Writable atom for the bounded ring of recent chain events. Append
 *  semantics enforced by `appendChainEvent` push helper. */
export const chainEventLogAtom: Atom.Writable<readonly ChainEventEntry[]> = Atom.keepAlive(
  Atom.make<readonly ChainEventEntry[]>([]),
);

// ---------------------------------------------------------------------------
// Sync sparkline (rolling window of slots-behind-tip)
// ---------------------------------------------------------------------------

/**
 * Rolling 600-pt window of `(currentSlot - tipSlot)` samples at 1Hz —
 * driven by the host's per-second poll. uPlot consumes `[xs, ys]`
 * columnar arrays; we hold a single 1-D number array here and let the
 * sparkline component build the timestamp axis from sample index +
 * `Date.now()` at render time.
 *
 * 600 samples = 10 minutes of history at 1Hz; matches a typical
 * "is-the-node-keeping-up" diagnostic horizon.
 */
export const SYNC_SPARKLINE_CAP = 600;

export const syncSparklineAtom: Atom.Writable<readonly number[]> = Atom.keepAlive(
  Atom.make<readonly number[]>([]),
);

// ---------------------------------------------------------------------------
// Push helpers — consumers (apps/tui, chrome-ext popup StorageBridge) call
// these to drive the registry from real consensus services. Helpers take
// an `AtomRegistry.AtomRegistry` directly rather than yielding a Service
// because both hosts already have a registry instance bound (TUI: module-
// level via `AtomRegistry.make()`; chrome-ext: per-popup-open via
// `RegistryContext.Provider`'s value), and a function-level dependency
// keeps the helpers usable from non-Effect call sites (e.g., chrome-ext's
// `chrome.storage.onChanged` listener which is a vanilla DOM callback).
// ---------------------------------------------------------------------------

type Registry = AtomRegistryModule.AtomRegistry;

/** Replace the mempool snapshot atom with a fresh array. */
export const pushMempoolSnapshot = (registry: Registry, entries: readonly MempoolEntry[]): void => {
  registry.set(mempoolSnapshotAtom, entries);
};

/** Replace the chain-event-log atom with a producer-side snapshot
 *  (chrome-ext flow: SW writes the bounded ring to `chrome.storage.session`,
 *  popup reads it on `onChanged` and calls this helper to mirror it locally).
 *  Defensive cap applied even though producers cap at 256. */
export const pushChainEventLog = (registry: Registry, events: readonly ChainEventEntry[]): void => {
  registry.set(chainEventLogAtom, takeRight(events, CHAIN_EVENT_LOG_CAP));
};

/** Generic single-item append-with-cap. Reads the current ring, concatenates
 *  the new item, and trims to `cap` via `takeRight` — single-write semantics
 *  so subscribers see one notification per call. */
const appendCapped = <A>(
  registry: Registry,
  atom: Atom.Writable<readonly A[]>,
  item: A,
  cap: number,
): void => {
  const prev = registry.get(atom);
  registry.set(atom, takeRight([...prev, item], cap));
};

/** Bulk append-with-cap. Skips entirely on empty input — degenerate writes
 *  would still notify subscribers. */
const appendCappedMany = <A>(
  registry: Registry,
  atom: Atom.Writable<readonly A[]>,
  items: readonly A[],
  cap: number,
): void => {
  if (items.length === 0) return;
  const prev = registry.get(atom);
  registry.set(atom, takeRight([...prev, ...items], cap));
};

/** Append one event to the bounded ring (TUI flow: subscribe to
 *  `ChainEventStream.stream` and call this per-event). */
export const appendChainEvent = (registry: Registry, event: ChainEventEntry): void =>
  appendCapped(registry, chainEventLogAtom, event, CHAIN_EVENT_LOG_CAP);

/** Append a batch of events in a single registry write — preferred over
 *  calling `appendChainEvent` in a tight loop, since each individual `set`
 *  triggers subscriber notifications. Burst-publish paths (e.g. journal
 *  replay on cold-start, batched ChainEventStream pulls) collapse N
 *  notifications into 1. */
export const appendChainEvents = (registry: Registry, events: readonly ChainEventEntry[]): void =>
  appendCappedMany(registry, chainEventLogAtom, events, CHAIN_EVENT_LOG_CAP);

/** Append one slot-distance sample to the sparkline ring. */
export const pushSyncSparklinePoint = (registry: Registry, slotsBehind: number): void =>
  appendCapped(registry, syncSparklineAtom, slotsBehind, SYNC_SPARKLINE_CAP);
