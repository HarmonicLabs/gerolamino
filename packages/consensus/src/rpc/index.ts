/**
 * ValidationClient — consensus-layer RPC boundary for CPU-bound
 * short-lease validation ops.
 *
 * Primary surface:
 *   - `ValidationClient` service tag (`validation-client.ts`) — 12-method
 *     interface covering consensus + primitive-crypto ops.
 *   - `ValidationDirectLayer` (`validation-direct-layer.ts`) — in-process
 *     implementation backed by `Crypto` from wasm-utils + Bun.CryptoHasher.
 *   - `ValidationRpcGroup` (`validation-rpc-group.ts`) — tagged RPC group
 *     for cross-Worker dispatch. Worker-layer shim deferred to Phase 5 (when
 *     apps/tui splits into main-thread + node-worker per plan Phase 5).
 *
 * Plan-compliant location (`packages/consensus/src/rpc/`) vs. the 6-method
 * crypto-primitive `CryptoRpcGroup` at `wasm-utils/src/rpc/` (which stays
 * as the primitive layer). Consensus stages bind to `ValidationClient` —
 * migration from `Crypto` is a one-line swap at the consumer side.
 */
export {
  Ed25519Verify,
  KesSum6Verify,
  CheckVrfLeader,
  VrfVerify,
  VrfProofToHash,
  Blake2b256Tagged,
  ValidateHeader,
  ValidateBlockBody,
  ComputeBodyHash,
  ComputeTxId,
  DecodeHeaderCbor,
  DecodeBlockCbor,
  ValidationRpcGroup,
  ValidationError,
  ValidatedHeader,
  ValidatedBlockBody,
} from "./validation-rpc-group.ts";
export { ValidationClient } from "./validation-client.ts";
export { ValidationDirectLayer } from "./validation-direct-layer.ts";
export { ValidationHandlersLive } from "./validation-handlers.ts";
export {
  AtomDelta,
  ChainTipResult,
  GetChainTip,
  GetMempool,
  GetPeers,
  GetSyncStatus,
  NodeRpcGroup,
  PeerInfo,
  SubmitTx,
  SubscribeAtoms,
  SubscribeChainEvents,
  SyncStatus,
  TxSummary,
} from "./node-rpc-group.ts";
export { NodeRpcHandlersLive } from "./node-rpc-handlers.ts";

// Back-compat: keep re-exporting the 6-method primitive group from wasm-utils
// so migration is gradual — consumers that want ValidationClient switch one
// import line; consumers that stay on the primitive group are untouched.
export {
  CryptoRpcGroup,
  CryptoRpcClient,
  CryptoWorkerBun,
} from "wasm-utils/rpc/index.ts";
