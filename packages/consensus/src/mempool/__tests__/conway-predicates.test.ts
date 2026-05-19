/**
 * Test-coverage gap (no per-predicate test file) — Conway-era mempool
 * predicate tags 0..62 across the 4 predicate groups (UTXOW + UTXO +
 * UTXOS + GOV).
 *
 * The existing `mempool.test.ts:20-26` only pins the COUNT of each
 * group (19/23/2/19 = 63). This file pins the EXACT `_tag` literal
 * each tagged-union member produces, so a Haskell-spec-divergent
 * rename (e.g. someone "fixing" `WrongNetwork → InvalidNetwork`)
 * surfaces here at the construction boundary instead of as a silent
 * drift in mempool RPC error reporting.
 *
 * Spec references (per `conway-predicates.ts:5-10`):
 *   - eras/conway/impl/src/Cardano/Ledger/Conway/Rules/Utxow.hs
 *   - eras/conway/impl/src/Cardano/Ledger/Conway/Rules/Utxo.hs
 *   - eras/conway/impl/src/Cardano/Ledger/Conway/Rules/Utxos.hs
 *   - eras/conway/impl/src/Cardano/Ledger/Conway/Rules/Gov.hs
 */
import { describe, it, expect } from "vitest";
import {
  ConwayUtxowPredFailure,
  ConwayUtxoPredFailure,
  ConwayUtxosPredFailure,
  ConwayGovPredFailure,
  GOV_PREDICATE_COUNT,
  UTXOW_PREDICATE_COUNT,
  UTXO_PREDICATE_COUNT,
  UTXOS_PREDICATE_COUNT,
} from "../conway-predicates.ts";

// Canonical tag lists per Haskell ground-truth (Conway impl, listed
// per spec line in conway-predicates.ts). A test that adds a tag here
// has to be deliberate, and a renumbering would have to update the
// expectation explicitly.
const UTXOW_TAGS: ReadonlyArray<string> = [
  "UtxoFailure",
  "InvalidWitnessesUTXOW",
  "MissingVKeyWitnessesUTXOW",
  "MissingScriptWitnessesUTXOW",
  "ScriptWitnessNotValidatingUTXOW",
  "MissingTxBodyMetadataHash",
  "MissingTxMetadata",
  "ConflictingMetadataHash",
  "InvalidMetadata",
  "ExtraneousScriptWitnessesUTXOW",
  "MissingRedeemers",
  "MissingRequiredDatums",
  "NotAllowedSupplementalDatums",
  "PPViewHashesDontMatch",
  "UnspendableUTxONoDatumHash",
  "ExtraRedeemers",
  "MalformedScriptWitnesses",
  "MalformedReferenceScripts",
  "ScriptIntegrityHashMismatch",
];

const UTXO_TAGS: ReadonlyArray<string> = [
  "UtxosFailure",
  "BadInputsUTxO",
  "OutsideValidityIntervalUTxO",
  "MaxTxSizeUTxO",
  "InputSetEmptyUTxO",
  "FeeTooSmallUTxO",
  "ValueNotConservedUTxO",
  "WrongNetwork",
  "WrongNetworkWithdrawal",
  "OutputTooSmallUTxO",
  "OutputBootAddrAttrsTooBig",
  "OutputTooBigUTxO",
  "InsufficientCollateral",
  "ScriptsNotPaidUTxO",
  "ExUnitsTooBigUTxO",
  "CollateralContainsNonADA",
  "WrongNetworkInTxBody",
  "OutsideForecast",
  "TooManyCollateralInputs",
  "NoCollateralInputs",
  "IncorrectTotalCollateralField",
  "BabbageOutputTooSmallUTxO",
  "BabbageNonDisjointRefInputs",
];

const UTXOS_TAGS: ReadonlyArray<string> = [
  "ValidationTagMismatch",
  "CollectErrors",
];

const GOV_TAGS: ReadonlyArray<string> = [
  "GovActionsDoNotExist",
  "MalformedProposal",
  "ProposalProcedureNetworkIdMismatch",
  "TreasuryWithdrawalsNetworkIdMismatch",
  "ProposalDepositIncorrect",
  "DisallowedVoters",
  "ConflictingCommitteeUpdate",
  "ExpirationEpochTooSmall",
  "InvalidPrevGovActionId",
  "VotingOnExpiredGovAction",
  "ProposalCantFollow",
  "InvalidGuardrailsScriptHash",
  "DisallowedProposalDuringBootstrap",
  "DisallowedVotesDuringBootstrap",
  "VotersDoNotExist",
  "ZeroTreasuryWithdrawals",
  "ProposalReturnAccountDoesNotExist",
  "TreasuryWithdrawalReturnAccountsDoNotExist",
  "UnelectedCommitteeVoters",
];

// `Schema.toTaggedUnion(...)` exposes `.cases` as a record keyed by
// `_tag` literals. Probing `union.cases[tag] !== undefined` is the
// cheapest way to assert the tag is part of the runtime union shape;
// `.make({...})` would also work but validates fields at construction
// time, which is more setup than this discriminant-pin test needs.
const tagExistsInUnion = (
  union: { cases: Record<string, unknown> },
  tag: string,
): boolean => union.cases[tag] !== undefined;

describe("Conway UTXOW predicates — tag discriminant coverage", () => {
  it("size matches UTXOW_PREDICATE_COUNT", () => {
    expect(UTXOW_TAGS.length).toBe(UTXOW_PREDICATE_COUNT);
  });

  for (const tag of UTXOW_TAGS) {
    it(`tag "${tag}" exists in the runtime union`, () => {
      expect(tagExistsInUnion(ConwayUtxowPredFailure, tag)).toBe(true);
    });
  }
});

describe("Conway UTXO predicates — tag discriminant coverage", () => {
  it("size matches UTXO_PREDICATE_COUNT", () => {
    expect(UTXO_TAGS.length).toBe(UTXO_PREDICATE_COUNT);
  });

  for (const tag of UTXO_TAGS) {
    it(`tag "${tag}" exists in the runtime union`, () => {
      expect(tagExistsInUnion(ConwayUtxoPredFailure, tag)).toBe(true);
    });
  }
});

describe("Conway UTXOS predicates — tag discriminant coverage", () => {
  it("size matches UTXOS_PREDICATE_COUNT", () => {
    expect(UTXOS_TAGS.length).toBe(UTXOS_PREDICATE_COUNT);
  });

  for (const tag of UTXOS_TAGS) {
    it(`tag "${tag}" exists in the runtime union`, () => {
      expect(tagExistsInUnion(ConwayUtxosPredFailure, tag)).toBe(true);
    });
  }
});

describe("Conway GOV predicates — tag discriminant coverage", () => {
  it("size matches GOV_PREDICATE_COUNT", () => {
    expect(GOV_TAGS.length).toBe(GOV_PREDICATE_COUNT);
  });

  for (const tag of GOV_TAGS) {
    it(`tag "${tag}" exists in the runtime union`, () => {
      expect(tagExistsInUnion(ConwayGovPredFailure, tag)).toBe(true);
    });
  }
});
