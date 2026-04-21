/**
 * Pre-built optic compositions for navigating the ExtLedgerState tree.
 *
 * Consumers that drill deep into the state (e.g., `state.newEpochState
 * .epochState.ledgerState.utxoState.govState.currentPParams`) can replace
 * that chain with `Optic.getOrThrow(LedgerOptics.currentPParams)(state)` —
 * or use the same lens to immutably update in place via `.modify` / `.replace`.
 *
 * Each exported optic is a `Lens<ExtLedgerState, A>`:
 *   - `.get(s): A`           — read (total; never fails on well-typed input)
 *   - `.replace(a, s): S`    — immutable update (returns a new tree)
 *   - `.modify(f): (s) => S` — immutable transform under `f`
 *
 * Composition rule: `Iso ⊂ Lens ⊂ Optional`. These are all Lenses because
 * every traversed field is a plain readonly struct slot — never a union
 * variant or optional key. If later work needs variant-specific navigation
 * (e.g., isolating a particular `DRep` kind), compose with `.tag(...)` at
 * the call site to get a `Prism`.
 */
import { Optic } from "effect";
import type {
  ExtLedgerState,
  EpochState,
  LedgerState,
  CertState,
  UTxOState,
  NewEpochState,
} from "./new-epoch-state.ts";

// ────────────────────────────────────────────────────────────────────────────
// Top-level NewEpochState and its immediate children.
// ────────────────────────────────────────────────────────────────────────────

export const newEpochState: Optic.Lens<ExtLedgerState, NewEpochState> =
  Optic.id<ExtLedgerState>().key("newEpochState");

export const epoch = newEpochState.key("epoch");
export const blocksMadePrev = newEpochState.key("blocksMadePrev");
export const blocksMadeCur = newEpochState.key("blocksMadeCur");
export const poolDistr = newEpochState.key("poolDistr");
export const pools = poolDistr.key("pools");
export const totalActiveStake = poolDistr.key("totalActiveStake");

// ────────────────────────────────────────────────────────────────────────────
// EpochState → LedgerState → {CertState, UTxOState}.
// ────────────────────────────────────────────────────────────────────────────

export const epochState: Optic.Lens<ExtLedgerState, EpochState> = newEpochState.key("epochState");
export const chainAccountState = epochState.key("chainAccountState");
export const treasury = chainAccountState.key("treasury");
export const reserves = chainAccountState.key("reserves");

export const ledgerState: Optic.Lens<ExtLedgerState, LedgerState> = epochState.key("ledgerState");
export const certState: Optic.Lens<ExtLedgerState, CertState> = ledgerState.key("certState");
export const utxoState: Optic.Lens<ExtLedgerState, UTxOState> = ledgerState.key("utxoState");

// ────────────────────────────────────────────────────────────────────────────
// CertState sub-states — DState (accounts, genDelegs, IR), PState (pools),
// VState (dreps, committee, dormantEpochs).
// ────────────────────────────────────────────────────────────────────────────

export const dState = certState.key("dState");
export const accounts = dState.key("accounts");
export const genDelegs = dState.key("genDelegs");
export const instantaneousRewards = dState.key("instantaneousRewards");

export const pState = certState.key("pState");
export const stakePools = pState.key("stakePools");
export const futureStakePoolParams = pState.key("futureStakePoolParams");
export const retiring = pState.key("retiring");

export const vState = certState.key("vState");
export const dreps = vState.key("dreps");

// ────────────────────────────────────────────────────────────────────────────
// UTxOState sub-fields. `utxo` itself is `OpaqueCbor` — the real UTxO lives
// in LMDB, so this lens exposes only the CBOR value for byte-preservation.
// ────────────────────────────────────────────────────────────────────────────

export const deposited = utxoState.key("deposited");
export const fees = utxoState.key("fees");
export const donation = utxoState.key("donation");
export const instantStake = utxoState.key("instantStake");
export const govState = utxoState.key("govState");
export const currentPParams = govState.key("currentPParams");
export const previousPParams = govState.key("previousPParams");
export const futurePParams = govState.key("futurePParams");
export const constitution = govState.key("constitution");

// ────────────────────────────────────────────────────────────────────────────
// Top-level escape hatches — `chainDepState`, `tip`, `currentEra`.
// ────────────────────────────────────────────────────────────────────────────

export const chainDepState = Optic.id<ExtLedgerState>().key("chainDepState");
export const tip = Optic.id<ExtLedgerState>().key("tip");
export const currentEra = Optic.id<ExtLedgerState>().key("currentEra");
