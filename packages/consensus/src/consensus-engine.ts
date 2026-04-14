/**
 * ConsensusEngine — abstract service for the node's consensus logic.
 */
import { Context, Effect, Layer } from "effect";
import type { BlockHeader, LedgerView } from "./validate-header";
import type { ChainTip, GsmState } from "./chain-selection";
import { HeaderValidationError, validateHeader } from "./validate-header";
import { preferCandidate, gsmState } from "./chain-selection";
import { CryptoService, CryptoServiceBunNative, CryptoServiceLive } from "./crypto";
import { CryptoWorkerPool, CryptoWorkerPoolLive, CryptoWorkerPoolWithSpawner } from "./crypto-pool";
import type * as Worker from "effect/unstable/workers/Worker";

export class ConsensusEngine extends Context.Service<
  ConsensusEngine,
  {
    readonly validateHeader: (
      header: BlockHeader,
      view: LedgerView,
    ) => Effect.Effect<void, HeaderValidationError>;
    readonly selectChain: (
      ours: ChainTip,
      candidate: ChainTip,
      forkDepth: number,
      securityParam: number,
    ) => boolean;
    readonly getGsmState: (
      tipSlot: bigint,
      wallclockSlot: bigint,
      stabilityWindow: bigint,
    ) => GsmState;
  }
>()("consensus/ConsensusEngine") {}

/** Default ConsensusEngine layer. Requires CryptoService. */
export const ConsensusEngineLive: Layer.Layer<ConsensusEngine, never, CryptoService> = Layer.effect(
  ConsensusEngine,
  Effect.gen(function* () {
    const crypto = yield* CryptoService;
    return {
      validateHeader: (header: BlockHeader, view: LedgerView) =>
        validateHeader(header, view).pipe(Effect.provideService(CryptoService, crypto)),
      selectChain: (ours: ChainTip, candidate: ChainTip, forkDepth: number, k: number) =>
        preferCandidate(ours, candidate, forkDepth, k),
      getGsmState: (tipSlot: bigint, wallclockSlot: bigint, stabilityWindow: bigint) =>
        gsmState(tipSlot, wallclockSlot, stabilityWindow),
    };
  }),
);

/** Convenience: ConsensusEngine + CryptoService with Bun-native crypto (for testing). */
export const ConsensusEngineWithBunCrypto: Layer.Layer<ConsensusEngine | CryptoService> =
  ConsensusEngineLive.pipe(
    Layer.provideMerge(Layer.succeed(CryptoService, CryptoServiceBunNative)),
  );

/** Production: ConsensusEngine + CryptoService with real WASM crypto. */
export const ConsensusEngineWithWasmCrypto: Layer.Layer<ConsensusEngine | CryptoService> =
  ConsensusEngineLive.pipe(Layer.provideMerge(CryptoServiceLive));

/**
 * Production with worker pool: ConsensusEngine + CryptoService + CryptoWorkerPool.
 * Accepts a platform-specific worker layer (BunWorker.layer or BrowserWorker.layer)
 * that provides WorkerPlatform + Spawner.
 */
export const ConsensusEngineWithWorkerCrypto = (
  workerLayer: Layer.Layer<Worker.WorkerPlatform | Worker.Spawner>,
): Layer.Layer<ConsensusEngine | CryptoService | CryptoWorkerPool> =>
  ConsensusEngineLive.pipe(
    Layer.provideMerge(CryptoServiceLive),
    Layer.provideMerge(CryptoWorkerPoolWithSpawner(workerLayer)),
  );
