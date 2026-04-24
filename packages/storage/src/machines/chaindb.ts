/**
 * ChainDB state + pure reducer.
 *
 * Previously an XState parallel-region machine; the `blockProcessing`
 * region was a vestigial single-state (always `idle`) so only the
 * `immutability` region carried dynamics. Collapsing to a flat state +
 * pure reducer lets us drive transitions through a `SubscriptionRef`
 * with Effect fibers and drops the `xstate` dependency entirely.
 *
 * Lifecycle per-block, same as before:
 *   BlockAdded             → idle → copying (if volatileLength > k)
 *   PromoteDone            → copying → gc
 *   PromoteFailed          → copying → idle    (+ lastError)
 *   GcDone                 → gc → idle
 *   GcFailed               → gc → idle         (+ lastError)
 *   Rollback               → update tip
 *   ErrorRaised            → update lastError
 *
 * The reducer is referentially transparent; side effects (SQL writes,
 * BlobStore puts) are dispatched from `chain-db-live.ts` by observing
 * `SubscriptionRef<ChainDBState>` via `Stream.changesWith`.
 */
import type { RealPoint } from "../types/StoredBlock.ts";
import { ChainDBEvent } from "./events.ts";

export type ImmutabilityState = "idle" | "copying" | "gc";

export interface ChainDBState {
  readonly immutability: ImmutabilityState;
  readonly tip: RealPoint | undefined;
  readonly immutableTip: RealPoint | undefined;
  readonly securityParam: number;
  readonly volatileLength: number;
  readonly lastError: unknown;
}

export const initialChainDBState = (securityParam: number): ChainDBState => ({
  immutability: "idle",
  tip: undefined,
  immutableTip: undefined,
  securityParam,
  volatileLength: 0,
  lastError: undefined,
});

/**
 * Apply a single event. Exhaustive on `ChainDBEvent`'s tagged union;
 * `ChainDBEvent.match` enforces that at compile time.
 */
export const reduce = (state: ChainDBState, event: ChainDBEvent): ChainDBState =>
  ChainDBEvent.match(event, {
    BlockAdded: ({ tip }): ChainDBState => {
      const bumped: ChainDBState = {
        ...state,
        tip,
        volatileLength: state.volatileLength + 1,
      };
      // Threshold-crossing: idle → copying. Any other region state is
      // left alone — concurrent BlockAdded while copying/gc just
      // advances the volatile tip, the driver will pick it up on the
      // next idle-transition.
      return state.immutability === "idle" && bumped.volatileLength > state.securityParam
        ? { ...bumped, immutability: "copying" as const }
        : bumped;
    },
    PromoteDone: ({ promoted }): ChainDBState => ({
      ...state,
      immutability: "gc",
      immutableTip: state.tip,
      volatileLength: Math.max(0, state.volatileLength - promoted),
    }),
    PromoteFailed: ({ error }): ChainDBState => ({
      ...state,
      immutability: "idle",
      lastError: error,
    }),
    GcDone: (): ChainDBState => ({ ...state, immutability: "idle" }),
    GcFailed: ({ error }): ChainDBState => ({
      ...state,
      immutability: "idle",
      lastError: error,
    }),
    Rollback: ({ point }) => ({ ...state, tip: point }),
    ErrorRaised: ({ error }) => ({ ...state, lastError: error }),
  });
