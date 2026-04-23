/**
 * Effect Atoms for node state — shared reactive state consumed by
 * both OpenTUI (apps/tui) and Chrome extension (packages/chrome-ext).
 *
 * These atoms are framework-agnostic. UI frameworks consume them via
 * @effect/atom-solid hooks (useAtomValue, useAtom).
 */
import * as Atom from "effect/unstable/reactivity/Atom";
import * as Schema from "effect/Schema";

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

/** Writable atom for the node's sync/consensus state. */
export const nodeStateAtom: Atom.Writable<NodeState> = Atom.make(INITIAL_NODE_STATE);

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

export const PeerInfoStatus = Schema.Literals(["connected", "disconnected", "stalled"]);
export type PeerInfoStatus = typeof PeerInfoStatus.Type;

export const PeerInfo = Schema.Struct({
  id: Schema.String,
  status: PeerInfoStatus,
  tipSlot: Schema.BigInt,
  latencyMs: Schema.optionalKey(Schema.Number),
});
export type PeerInfo = typeof PeerInfo.Type;

/** Writable atom for the peer list. */
export const peersAtom: Atom.Writable<readonly PeerInfo[]> = Atom.make<readonly PeerInfo[]>([]);

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
export const bootstrapAtom: Atom.Writable<BootstrapProgress> = Atom.make(INITIAL_BOOTSTRAP);

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
export const networkInfoAtom: Atom.Writable<NetworkInfo> = Atom.make(INITIAL_NETWORK);

// ---------------------------------------------------------------------------
// Derived atoms (read-only)
// ---------------------------------------------------------------------------

/** Derived: is the node actively syncing? */
export const isSyncingAtom: Atom.Atom<boolean> = Atom.make((get) => {
  const state = get(nodeStateAtom);
  return state.status === "syncing" || state.status === "bootstrapping";
});

/** Derived: slots behind tip. */
export const slotsBehindAtom: Atom.Atom<bigint> = Atom.make((get) => {
  const state = get(nodeStateAtom);
  return state.currentSlot - state.tipSlot;
});

/** Derived: human-readable sync percentage string. */
export const syncPercentLabelAtom: Atom.Atom<string> = Atom.make((get) => {
  const state = get(nodeStateAtom);
  if (state.status === "caught-up") return "100%";
  if (state.status === "idle") return "--";
  return `${Math.min(state.syncPercent, 100).toFixed(1)}%`;
});
