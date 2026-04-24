/**
 * BlockFetch agency table — Ouroboros network-spec §4.7.
 *
 *        Client has agency                Server has agency
 *        ─────────────────                ─────────────────
 *
 *              Idle  ──MsgRequestRange──►  Busy
 *              Idle  ◄──MsgNoBlocks──────  Busy
 *          Streaming ◄─MsgStartBatch────   Busy
 *          Streaming ◄─MsgBlock───────    Streaming    (loop, server-side)
 *              Idle  ◄─MsgBatchDone─────  Streaming
 *              Done  ──MsgClientDone──►   Done
 *              Done  (Neither — terminal)
 *
 * The `MsgBlock` self-loop on `Streaming` is what makes BlockFetch a
 * streaming protocol — the server holds agency across many blocks until
 * it signals `MsgBatchDone`. Pipelining + batching at the consumer side
 * (plan Tier-1 §2c, Amaru convention `batchN(50)`): wrap requests in
 * `Request.tagged("FetchBlock", ...)` + `RequestResolver.batchN(50, base)`
 * + `RequestResolver.withCache("lru", { capacity: 1000 })`. The
 * transition table models the wire; the client layers batching on top.
 */
import { ProtocolState, filteredCodec } from "../../typed-channel";
import type { Transition } from "../../typed-channel";
import { BlockFetchMessageBytes, BlockFetchMessageType } from "./Schemas";
import type { BlockFetchMessageT } from "./Schemas";

type Narrow<Tag extends BlockFetchMessageType> = Extract<BlockFetchMessageT, { _tag: Tag }>;

export const state_Idle = ProtocolState.make("Idle", "Client");
export const state_Busy = ProtocolState.make("Busy", "Server");
export const state_Streaming = ProtocolState.make("Streaming", "Server");
export const state_Done = ProtocolState.make("Done", "Neither");

export const tRequestRange: Transition<
  typeof state_Idle,
  Narrow<BlockFetchMessageType.RequestRange>,
  typeof state_Busy
> = {
  from: state_Idle,
  to: state_Busy,
  message: filteredCodec(BlockFetchMessageBytes, BlockFetchMessageType.RequestRange),
};

export const tNoBlocks: Transition<
  typeof state_Busy,
  Narrow<BlockFetchMessageType.NoBlocks>,
  typeof state_Idle
> = {
  from: state_Busy,
  to: state_Idle,
  message: filteredCodec(BlockFetchMessageBytes, BlockFetchMessageType.NoBlocks),
};

export const tStartBatch: Transition<
  typeof state_Busy,
  Narrow<BlockFetchMessageType.StartBatch>,
  typeof state_Streaming
> = {
  from: state_Busy,
  to: state_Streaming,
  message: filteredCodec(BlockFetchMessageBytes, BlockFetchMessageType.StartBatch),
};

export const tBlock: Transition<
  typeof state_Streaming,
  Narrow<BlockFetchMessageType.Block>,
  typeof state_Streaming
> = {
  from: state_Streaming,
  to: state_Streaming,
  message: filteredCodec(BlockFetchMessageBytes, BlockFetchMessageType.Block),
};

export const tBatchDone: Transition<
  typeof state_Streaming,
  Narrow<BlockFetchMessageType.BatchDone>,
  typeof state_Idle
> = {
  from: state_Streaming,
  to: state_Idle,
  message: filteredCodec(BlockFetchMessageBytes, BlockFetchMessageType.BatchDone),
};

export const tClientDone: Transition<
  typeof state_Idle,
  Narrow<BlockFetchMessageType.ClientDone>,
  typeof state_Done
> = {
  from: state_Idle,
  to: state_Done,
  message: filteredCodec(BlockFetchMessageBytes, BlockFetchMessageType.ClientDone),
};

export const blockFetchTransitions = [
  tRequestRange,
  tNoBlocks,
  tStartBatch,
  tBlock,
  tBatchDone,
  tClientDone,
] as const;
