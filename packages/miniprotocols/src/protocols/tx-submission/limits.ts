/**
 * TxSubmission2 protocol invariants.
 *
 * Per Haskell `ouroboros-network/lib/Ouroboros/Network/TxSubmission/
 * Inbound/V2/Policy.hs:71`:
 *   maxUnacknowledgedTxIds = 10, -- must be the same as txSubmissionMaxUnacked
 *
 * Also echoed at `cardano-diffusion/lib/Cardano/Network/NodeToNode.hs:430`.
 *
 * This is a **receiver-side** invariant: when we implement the inbound
 * TxSubmission handler (Phase 3e Mempool Entity), we MUST NOT have more
 * than 10 outstanding (unacknowledged) txIds in flight per peer. Sending
 * a `RequestTxIds { ack, req }` such that the new outstanding count would
 * exceed 10 is a protocol violation by US.
 *
 * The current Client.ts in this package is the outbound (sender) side —
 * it responds to `RequestTxIds(ack, req)` with at most `req` new txIds.
 * The cap enforcement belongs with the inbound handler.
 */

/**
 * Maximum outstanding tx-ids per peer. See module docstring for spec refs.
 */
export const MAX_UNACKED_TX_IDS = 10;

/**
 * Check: after applying `ack` acknowledgments and requesting `req` new ids,
 * would we exceed the outstanding-ids cap given the current `unacked` count?
 *
 * Returns `true` if the request is valid to send.
 */
export const isValidRequestWindow = (currentUnacked: number, ack: number, req: number): boolean =>
  currentUnacked - ack + req <= MAX_UNACKED_TX_IDS;
