/**
 * Bun Worker entrypoint for the Crypto RPC server.
 *
 * Spawned by `CryptoWorker.layerBun` (see `crypto-client.ts`) as
 * `new Worker(new URL("./crypto-worker.ts", import.meta.url))`. Runs the
 * raw wasm-bindgen crypto functions on a dedicated OS thread.
 */
import * as BunWorkerRunner from "@effect/platform-bun/BunWorkerRunner";
import { Effect, Layer } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { CryptoHandlersLive } from "./crypto-handlers.ts";
import { CryptoRpcGroup } from "./crypto-rpc.ts";

const WorkerLive = RpcServer.layer(CryptoRpcGroup).pipe(
  Layer.provide(CryptoHandlersLive),
  Layer.provide(RpcSerialization.layerMsgPack),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BunWorkerRunner.layer),
);

Effect.runFork(Layer.launch(WorkerLive));
