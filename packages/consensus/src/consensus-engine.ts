/**
 * ConsensusEngine — abstract service for the node's consensus logic.
 */
import { Effect, Layer, ServiceMap } from "effect";
import type { BlockHeader, LedgerView } from "./validate-header";
import type { ChainTip, GsmState } from "./chain-selection";
import { HeaderValidationError, validateHeader } from "./validate-header";
import { preferCandidate, gsmState } from "./chain-selection";
import { CryptoService, CryptoServiceBunNative } from "./crypto";

export class ConsensusEngine extends ServiceMap.Service<
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
export const ConsensusEngineLive: Layer.Layer<ConsensusEngine, never, CryptoService> =
  Layer.effect(
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

/** Convenience: ConsensusEngine with Bun-native crypto (for testing). */
export const ConsensusEngineWithBunCrypto: Layer.Layer<ConsensusEngine> =
  ConsensusEngineLive.pipe(
    Layer.provide(Layer.succeed(CryptoService, CryptoServiceBunNative)),
  );
