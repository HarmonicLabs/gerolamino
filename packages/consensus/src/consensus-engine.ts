/**
 * ConsensusEngine — abstract service for the node's consensus logic.
 *
 * This is the main F-algebra that the node program yields from.
 * Entry points (TUI, Chrome ext) provide concrete layers.
 */
import { Effect, ServiceMap } from "effect";
import type { BlockHeader, LedgerView } from "./validate-header";
import type { ChainTip, GsmState } from "./chain-selection";
import { HeaderValidationError, validateHeader } from "./validate-header";
import { preferCandidate, gsmState } from "./chain-selection";

export interface ConsensusEngineShape {
  /** Validate a block header against the current ledger view. */
  readonly validateHeader: (
    header: BlockHeader,
    view: LedgerView,
  ) => Effect.Effect<void, HeaderValidationError>;

  /** Compare candidate chain tip against our tip for chain selection. */
  readonly selectChain: (
    ours: ChainTip,
    candidate: ChainTip,
    forkDepth: number,
    securityParam: number,
  ) => boolean;

  /** Get current GSM state. */
  readonly getGsmState: (
    tipSlot: bigint,
    wallclockSlot: bigint,
    stabilityWindow: bigint,
  ) => GsmState;
}

export class ConsensusEngine extends ServiceMap.Service<ConsensusEngine, ConsensusEngineShape>()(
  "consensus/ConsensusEngine",
) {}

/** Default ConsensusEngine implementation. */
export const ConsensusEngineLive = Effect.succeed({
  validateHeader: (header, view) => validateHeader(header, view),
  selectChain: (ours, candidate, forkDepth, k) =>
    preferCandidate(ours, candidate, forkDepth, k),
  getGsmState: (tipSlot, wallclockSlot, stabilityWindow) =>
    gsmState(tipSlot, wallclockSlot, stabilityWindow),
} satisfies ConsensusEngineShape);
