/**
 * Popup snapshot upload RpcClient — always `OffscreenRpcs` over BroadcastChannel.
 */
import { Effect, Schedule } from "effect";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { NodeRpcs } from "../background/rpc.ts";
import { OffscreenRpcs } from "../offscreen/rpc.ts";
export type NodeUploadRpcClient = RpcClient.FromGroup<typeof NodeRpcs, RpcClientError>;
export type OffscreenUploadRpcClient = RpcClient.FromGroup<typeof OffscreenRpcs, RpcClientError>;

/** Wait until popup → offscreen BC relay answers (`Ping`, no lsm-worker). */
export const waitForOffscreenUploadReady = (client: OffscreenUploadRpcClient) =>
  client.Ping().pipe(
    Effect.asVoid,
    Effect.retry({
      schedule: Schedule.spaced("500 millis"),
      times: 120,
    }),
    Effect.timeout("120 seconds"),
  );

/** @deprecated Use `waitForOffscreenUploadReady` — upload no longer uses Port → SW. */
export const waitForProductionOffscreenRelay = waitForOffscreenUploadReady;

export const makeNodeUploadClient = () => RpcClient.make(NodeRpcs);

export const makeOffscreenUploadClient = () => RpcClient.make(OffscreenRpcs);
