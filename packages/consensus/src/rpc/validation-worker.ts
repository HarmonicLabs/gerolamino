/**
 * Bun Worker entrypoint for the `ValidationRpcGroup` RPC server.
 *
 * Spawned by `ValidationWorkerBun` (see `validation-worker-layer.ts`) as
 * `new Worker(new URL("./validation-worker.ts", import.meta.url))`. Each
 * worker boots the WASM crypto module once via `CryptoDirect` and serves
 * the 12-method group across a MessagePort boundary.
 *
 * Multiplexing happens at the RPC layer: one Worker serves up to
 * `concurrency` in-flight calls simultaneously via auto-tracked request IDs
 * (`RpcClient.ts:333-334`). Pool<Worker> of `size` workers is acquired
 * greedy-first-available (`Pool.ts:335, :341`).
 */
import * as BunWorkerRunner from "@effect/platform-bun/BunWorkerRunner";
import { Effect, Layer } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { CryptoDirect } from "wasm-utils";

import { ValidationHandlersLive } from "./validation-handlers.ts";
import { ValidationRpcGroup } from "./validation-rpc-group.ts";

const WorkerLive = RpcServer.layer(ValidationRpcGroup).pipe(
  Layer.provide(ValidationHandlersLive),
  Layer.provide(CryptoDirect),
  Layer.provide(RpcSerialization.layerMsgPack),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BunWorkerRunner.layer),
);

Effect.runFork(Layer.launch(WorkerLive));
