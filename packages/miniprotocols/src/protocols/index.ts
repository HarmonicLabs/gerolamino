/**
 * Barrel for the 10 Ouroboros mini-protocols implemented in this package.
 *
 * Each protocol subdirectory exposes a `Client` service (for outbound
 * operations) + `Schemas` (tagged-union wire messages). Typed message
 * types are re-exported via each directory's own `index.ts`.
 *
 * Protocols:
 *   - Node-to-node (N2N): handshake, chain-sync, block-fetch, tx-submission,
 *     keep-alive, peer-sharing
 *   - Node-to-client (N2C): local-chain-sync, local-state-query,
 *     local-tx-submit, local-tx-monitor
 *
 * `node-to-node-version` is NOT a standalone protocol — its version data
 * lives inside `handshake/Schemas.ts` (`NodeToNodeVersionData`) per the
 * Haskell handshake negotiation shape.
 */
export * as Handshake from "./handshake";
export * as KeepAlive from "./keep-alive";
export * as PeerSharing from "./peer-sharing";
export * as ChainSync from "./chain-sync";
export * as BlockFetch from "./block-fetch";
export * as TxSubmission from "./tx-submission";
export * as LocalChainSync from "./local-chain-sync";
export * as LocalStateQuery from "./local-state-query";
export * as LocalTxSubmit from "./local-tx-submit";
export * as LocalTxMonitor from "./local-tx-monitor";
