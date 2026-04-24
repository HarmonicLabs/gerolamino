/**
 * consensus — Ouroboros Praos consensus layer barrel.
 *
 * Source is organised into topical subdirectories:
 *   bridges/    — cross-package adapters (ledger → consensus shapes)
 *   chain/      — chain selection + event log + Fibonacci point selector
 *   hard-fork/  — era history + validator routing
 *   mempool/    — Mempool service + 63-predicate Conway UTXOW surface
 *   peer/       — peer manager + UI-facing ConsensusEvents PubSub
 *   praos/      — clock + nonce + composed consensus engine
 *   rpc/        — ValidationRpcGroup (12 methods) + NodeRpcGroup (7 methods)
 *   stage/      — SyncStage pipeline primitive
 *   sync/       — N2N sync driver + bootstrap pipeline + relay connection
 *   validate/   — header / block / apply
 *   workflow/   — BlockSync Workflow + handler layer
 *
 * Top-level files: node.ts (orchestrator), observability.ts (Metric +
 * SPAN declarations), util.ts (byte-primitive re-exports from codecs).
 */

// ─────────────────────────────── praos ───────────────────────────────
export {
  Nonces,
  evolveNonce,
  deriveEpochNonce,
  isPastStabilizationWindow,
} from "./praos/nonce";
export {
  SlotClock,
  SlotClockLive,
  SlotClockLayerFromConfig,
  SlotClockPreprod,
  SlotClockMainnet,
  SlotClockLiveFromEnvOrPreprod,
  SlotConfig,
  SlotConfigFromEnv,
  PREPROD_CONFIG,
  MAINNET_CONFIG,
} from "./praos/clock";
// The `ConsensusEngine` service was removed — its three methods were
// one-line passthroughs to pure helpers (`validateHeader`, `preferCandidate`,
// `gsmState`). Consumers now import those helpers directly and bind `Crypto`
// at the app entrypoint (via `CryptoDirect` or `CryptoWorkerBun` from
// `wasm-utils` / `wasm-utils/rpc/bun.ts`). This is a plain-function + Layer
// composition, not a dedicated service + Layer.

// ─────────────────────────────── chain ───────────────────────────────
export {
  ChainTip,
  preferCandidate,
  GsmState,
  gsmState,
} from "./chain/selection";
export { FIBONACCI_OFFSETS, fibonacciPoints } from "./chain/points";
export {
  ChainEvent,
  ChainEventGroup,
  ChainEventLogSchema,
  ChainEventStream,
  ChainEventsLive,
  RollbackTarget,
  writeChainEvent,
  type ChainEventType,
  type RollbackTargetType,
} from "./chain/event-log";
export {
  CHAIN_REACTIVITY_KEYS,
  ChainAtomsLive,
  ChainReactivityKeysLayer,
  chainLengthAtom,
  chainTipAtom,
  epochAtom,
  epochNonceAtom,
  rollbackCountAtom,
  type ChainTipSnapshot,
} from "./chain/atoms";

// ─────────────────────────────── validate ───────────────────────────────
export {
  validateHeader,
  HeaderValidationError,
  BlockHeader,
  LedgerView,
  PrevTip,
} from "./validate/header";
export {
  validateBlock,
  verifyBodyHash,
  BlockValidationError,
} from "./validate/block";
export { applyBlock, BlockDiff } from "./validate/apply";

// ─────────────────────────────── sync ───────────────────────────────
export {
  processBlock,
  getSyncState,
  syncFromStream,
  SyncError,
  SyncState,
} from "./sync/bootstrap";
export { VolatileState, initialVolatileState } from "./sync/driver";
export {
  connectToRelay,
  PREPROD_MAGIC,
  MAINNET_MAGIC,
  RelayError,
  RelayRetrySchedule,
} from "./sync/relay";

// ─────────────────────────────── peer ───────────────────────────────
export {
  PeerManager,
  PeerManagerLayer,
  PeerManagerLive,
  PeerState,
  PeerStatus,
} from "./peer/manager";
export {
  ConsensusEvents,
  ConsensusEvent,
  ConsensusEventKind,
  type ConsensusEventType,
} from "./peer/events";

// ─────────────────────────────── bridges ───────────────────────────────
export {
  bridgeHeader,
  bridgeMultiEraHeader,
  computeHeaderHash,
  computeHeaderHashFromHeader,
  decodeAndBridge,
  decodeWrappedHeader,
  DecodedHeader,
  ByronHeaderInfo,
  ShelleyHeaderInfo,
  HeaderBridgeError,
} from "./bridges/header";
export {
  extractLedgerView,
  extractNonces,
  extractOcertCounters,
  extractSnapshotTip,
  SnapshotDecodeError,
} from "./bridges/ledger-view";

// ─────────────────────────────── hard-fork ───────────────────────────────
export {
  EraBoundary,
  EraHistory,
  EraHistoryOrderError,
  crossesEraBoundary,
  eraAtSlot,
  validateEraHistory,
} from "./hard-fork";

// ─────────────────────────────── mempool ───────────────────────────────
export {
  CONWAY_PREDICATE_TOTAL,
  ConwayGovPredFailure,
  ConwayUtxoPredFailure,
  ConwayUtxosPredFailure,
  ConwayUtxowPredFailure,
  GOV_PREDICATE_COUNT,
  Mempool,
  MempoolEntry,
  MempoolError,
  MempoolRuleError,
  SubmitResult,
  UTXOS_PREDICATE_COUNT,
  UTXOW_PREDICATE_COUNT,
  UTXO_PREDICATE_COUNT,
} from "./mempool";

// ─────────────────────────────── stage ───────────────────────────────
export { SyncStage, runStage, connect as connectStages } from "./stage";

// ─────────────────────────────── workflow ───────────────────────────────
export {
  BlockSyncWorkflow,
  BlockSyncHandlerLive,
  BlockSyncError,
  BlockSyncSuccess,
  Point as BlockSyncPoint,
  type BlockSyncErrorT,
  type BlockSyncSuccessT,
} from "./workflow";

// ─────────────────────────────── rpc ───────────────────────────────
export {
  PeerInfo,
  PeerInfoStatus,
  ValidationClient,
  ValidationDirectLayer,
  ValidationError,
  ValidationRpcGroup,
} from "./rpc";

// ─────────────────────────────── persistence ───────────────────────────────
export {
  HeaderCache,
  HeaderCacheKey,
  HeaderDecodeError,
  PersistenceLayerMemory,
  VrfCache,
  VrfCacheKey,
  VrfVerifyError,
  headerCacheLayer,
  vrfCacheLayer,
} from "./persistence";

// ─────────────────────────────── top-level ───────────────────────────────
export { getNodeStatus, monitorLoop, NodeStatus } from "./node";
export {
  BlockAccepted as MetricBlockAccepted,
  BlockValidationFailed as MetricBlockValidationFailed,
  ChainLength as MetricChainLength,
  ChainTipSlot as MetricChainTipSlot,
  EpochBoundaryCount as MetricEpochBoundaryCount,
  PeerCount as MetricPeerCount,
  PeerStalledCount as MetricPeerStalledCount,
  RollbackCount as MetricRollbackCount,
  SPAN,
} from "./observability";
export { concat, compareBytes, be32, be64 } from "./util";
