/**
 * Consensus-layer RPC surface — browser-safe abstract exports only.
 *
 * Primary surface:
 *   - `ValidationClient` service tag (`validation-client.ts`) — 12-method
 *     interface covering consensus + primitive-crypto ops.
 *   - `ValidationDirectLayer` (`validation-direct-layer.ts`) — in-process
 *     implementation backed by `Crypto` from wasm-utils (browser-compatible).
 *   - `ValidationFromRpc` + `ValidationRpcClient` (`validation-rpc-client.ts`)
 *     — transport-agnostic layer/client; bind a concrete Worker spawner
 *     from `./bun.ts` (Bun) or a future `./browser.ts` (chrome-ext wave).
 *   - `ValidationRpcGroup` (`validation-rpc-group.ts`) — the wire contract.
 *
 * Bun-specific worker spawners live at `consensus/rpc/bun.ts` and are NOT
 * re-exported here so browser bundles don't transitively pull in
 * `@effect/platform-bun`.
 */
export {
  Ed25519Verify,
  KesSum6Verify,
  CheckVrfLeader,
  VrfVerify,
  VrfProofToHash,
  Blake2b256Tagged,
  ComputeBodyHash,
  ComputeTxId,
  DecodeBlockCbor,
  ValidationRpcGroup,
  ValidationError,
} from "./validation-rpc-group.ts";
export { ValidationClient } from "./validation-client.ts";
export { ValidationDirectLayer } from "./validation-direct-layer.ts";
export { ValidationHandlersLive } from "./validation-handlers.ts";
export { ValidationFromRpc, ValidationRpcClient } from "./validation-rpc-client.ts";
export {
  AtomDelta,
  ChainTipResult,
  GetChainTip,
  GetMempool,
  GetPeers,
  GetSyncStatus,
  NodeRpcGroup,
  PeerInfo,
  PeerInfoStatus,
  SubmitTx,
  SubscribeAtoms,
  SubscribeChainEvents,
  SyncMetrics,
  TxSummary,
} from "./node-rpc-group.ts";
export { NodeRpcHandlersLive } from "./node-rpc-handlers.ts";

// Abstract primitive-crypto group (handlers + wire contract). Bun-specific
// worker spawners (`CryptoWorkerBun`) live at `wasm-utils/rpc/bun.ts` and
// are NOT re-exported here for the same platform-agnosticism reason.
export { CryptoRpcGroup, CryptoRpcClient } from "wasm-utils/rpc/index.ts";
