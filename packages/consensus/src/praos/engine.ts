/**
 * ConsensusEngine — abstract service for the node's consensus logic.
 */
import { Context, Effect, Layer } from "effect";
import { Crypto, CryptoDirect, CryptoWorkerBun } from "wasm-utils";
import type { WorkerError } from "effect/unstable/workers/WorkerError";
import { PrevTip } from "../validate/header";
import type { BlockHeader, LedgerView } from "../validate/header";
import type { ChainTip, GsmState } from "../chain/selection";
import { HeaderValidationError, validateHeader } from "../validate/header";
import { preferCandidate, gsmState } from "../chain/selection";

export class ConsensusEngine extends Context.Service<
  ConsensusEngine,
  {
    readonly validateHeader: (
      header: BlockHeader,
      view: LedgerView,
      prevTip?: PrevTip,
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

/** Default ConsensusEngine layer. Requires the abstract `Crypto` service from wasm-utils. */
export const ConsensusEngineLive: Layer.Layer<ConsensusEngine, never, Crypto> = Layer.effect(
  ConsensusEngine,
  Effect.gen(function* () {
    const crypto = yield* Crypto;
    return {
      validateHeader: (header: BlockHeader, view: LedgerView, prevTip?: PrevTip) =>
        validateHeader(header, view, prevTip).pipe(Effect.provideService(Crypto, crypto)),
      selectChain: (ours: ChainTip, candidate: ChainTip, forkDepth: number, k: number) =>
        preferCandidate(ours, candidate, forkDepth, k),
      getGsmState: (tipSlot: bigint, wallclockSlot: bigint, stabilityWindow: bigint) =>
        gsmState(tipSlot, wallclockSlot, stabilityWindow),
    };
  }),
);

/**
 * Tests + hot paths: ConsensusEngine backed by in-process synchronous WASM crypto.
 */
export const ConsensusEngineWithDirectCrypto: Layer.Layer<ConsensusEngine | Crypto> =
  ConsensusEngineLive.pipe(Layer.provideMerge(CryptoDirect));

/**
 * Production: ConsensusEngine backed by the shared Bun Worker crypto pool.
 * Pool size is set by the wasm-utils layer (defaults to `navigator.hardwareConcurrency`).
 */
export const ConsensusEngineWithWorkerCrypto: Layer.Layer<
  ConsensusEngine | Crypto,
  WorkerError
> = ConsensusEngineLive.pipe(Layer.provideMerge(CryptoWorkerBun));
