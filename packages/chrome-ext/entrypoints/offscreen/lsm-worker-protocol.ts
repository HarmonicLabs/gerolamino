/**
 * Single-persistent-worker RPC protocol for the lsm-tree Worker.
 *
 * `RpcClient.layerProtocolWorker` calls `platform.spawn` inside each scoped
 * client, registering another `message` listener on the same Worker port when the
 * spawner returns a singleton instance. Symptom: 2–3× `writeChunk enter` per chunk.
 *
 * This layer calls `platform.spawn(0)` exactly once (globalThis memo) and
 * registers exactly one `backing.run` demux for the offscreen document lifetime.
 */
import { Effect, Layer, Latch, Option, Scope } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import * as RpcWorker from "effect/unstable/rpc/RpcWorker";
import * as Worker from "effect/unstable/workers/Worker";
import type { WorkerError } from "effect/unstable/workers/WorkerError";

type LsmBacking = Worker.Worker<
  FromServerEncoded,
  FromClientEncoded | RpcWorker.InitialMessage.Encoded
>;

type PendingEntry = {
  readonly protocolId: symbol;
  readonly clientId: number;
  readonly latch: Latch.Latch;
  readonly writeResponse: (clientId: number, response: FromServerEncoded) => Effect.Effect<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __GEROLAMINO_LSM_BACKING__: LsmBacking | undefined;
  // eslint-disable-next-line no-var
  var __GEROLAMINO_LSM_BACKING_RUN__: boolean | undefined;
}

const globalPending = new Map<string, PendingEntry>();

const acquireBacking = (
  platform: Worker.WorkerPlatform["Service"],
): Effect.Effect<LsmBacking, WorkerError, Worker.Spawner> =>
  Effect.gen(function* () {
    if (globalThis.__GEROLAMINO_LSM_BACKING__ !== undefined) {
      return globalThis.__GEROLAMINO_LSM_BACKING__;
    }
    const backing = yield* platform.spawn<
      FromServerEncoded,
      FromClientEncoded | RpcWorker.InitialMessage.Encoded
    >(0);
    globalThis.__GEROLAMINO_LSM_BACKING__ = backing;
    return backing;
  });

const startSharedRun = (backing: LsmBacking): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (globalThis.__GEROLAMINO_LSM_BACKING_RUN__ === true) return;
    globalThis.__GEROLAMINO_LSM_BACKING_RUN__ = true;
    yield* backing
      .run((response) => {
        if (response._tag === "Exit") {
          const entry = globalPending.get(response.requestId);
          if (entry) {
            globalPending.delete(response.requestId);
            entry.latch.openUnsafe();
            return entry.writeResponse(entry.clientId, response);
          }
        } else if (response._tag === "Defect") {
          for (const [, entry] of globalPending) {
            entry.latch.openUnsafe();
          }
          globalPending.clear();
          return Effect.void;
        } else if ("requestId" in response) {
          const entry = globalPending.get(response.requestId);
          if (entry) {
            return entry.writeResponse(entry.clientId, response);
          }
        }
        return Effect.void;
      })
      .pipe(Effect.orDie, Effect.forkScoped);
  });

export const layerLsmSingleWorkerProtocol: Layer.Layer<
  RpcClient.Protocol,
  WorkerError,
  Worker.WorkerPlatform | Worker.Spawner
> = Layer.effect(RpcClient.Protocol)(
  Effect.gen(function* () {
    const platform = yield* Worker.WorkerPlatform;
    const initialMessage = yield* Effect.serviceOption(RpcWorker.InitialMessage);
    const hooks = yield* Effect.serviceOption(RpcClient.ConnectionHooks);
    const backing = yield* acquireBacking(platform);
    if (Option.isSome(initialMessage)) {
      yield* initialMessage.value.pipe(
        Effect.flatMap(([value, transfers]) =>
          Effect.orDie(backing.send({ _tag: "InitialMessage", value }, transfers)),
        ),
      );
    }
    yield* startSharedRun(backing);

    return yield* RpcClient.Protocol.make(
      Effect.fnUntraced(function* (writeResponse, _clientIds) {
        const scope = yield* Effect.scope;
        const protocolId = Symbol("lsm-protocol");

        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            for (const [requestId, entry] of globalPending) {
              if (entry.protocolId === protocolId) {
                globalPending.delete(requestId);
                entry.latch.openUnsafe();
              }
            }
          }),
        );

        if (Option.isSome(hooks)) yield* hooks.value.onConnect;

        return {
          send(
            clientId: number,
            request: FromClientEncoded,
            transferables?: ReadonlyArray<globalThis.Transferable>,
          ) {
            switch (request._tag) {
              case "Request": {
                const latch = Latch.makeUnsafe(false);
                globalPending.set(request.id, {
                  protocolId,
                  clientId,
                  latch,
                  writeResponse,
                });
                return Effect.flatMap(backing.send(request, transferables), () =>
                  latch.await,
                ).pipe(Effect.orDie);
              }
              case "Interrupt": {
                const entry = globalPending.get(request.requestId);
                if (entry === undefined) return Effect.void;
                globalPending.delete(request.requestId);
                entry.latch.openUnsafe();
                return Effect.orDie(backing.send(request));
              }
              case "Ack": {
                const entry = globalPending.get(request.requestId);
                if (entry === undefined) return Effect.void;
                return Effect.orDie(backing.send(request));
              }
            }
            return Effect.void;
          },
          supportsAck: true,
          supportsTransferables: true,
        };
      }),
    );
  }),
);
