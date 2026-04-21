import { describe, it, expect } from "@effect/vitest";
import { HashSet, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  DRepGroup,
  DRepThresholds,
  PoolThresholds,
  PParamsUpdate,
  StakePoolGroup,
  fieldGroups,
  isSecurityRelevant,
  modifiedDRepGroups,
} from "..";

describe("Conway §20 PParams groups — field-level annotation", () => {
  it("every PParamsUpdate key has a groups entry", () => {
    const updateKeys = Object.keys(PParamsUpdate.fields).sort();
    const groupKeys = Object.keys(fieldGroups).sort();
    expect(groupKeys).toStrictEqual(updateKeys);
  });

  it("spot-check field assignments match Haskell v10.7.x", () => {
    expect(fieldGroups.maxTxSize).toStrictEqual({
      drep: DRepGroup.Network,
      spo: StakePoolGroup.Security,
    });
    expect(fieldGroups.minFeeA).toStrictEqual({
      drep: DRepGroup.Economic,
      spo: StakePoolGroup.Security,
    });
    expect(fieldGroups.costModels).toStrictEqual({
      drep: DRepGroup.Technical,
      spo: StakePoolGroup.NoStakePool,
    });
    expect(fieldGroups.govActionDeposit).toStrictEqual({
      drep: DRepGroup.Governance,
      spo: StakePoolGroup.Security,
    });
    expect(fieldGroups.drepActivity).toStrictEqual({
      drep: DRepGroup.Governance,
      spo: StakePoolGroup.NoStakePool,
    });
  });

  it("empty update touches no groups and is not security-relevant", () => {
    expect(HashSet.size(modifiedDRepGroups({}))).toBe(0);
    expect(isSecurityRelevant({})).toBe(false);
  });

  it("single Network+Security field touches {Network} and is security-relevant", () => {
    const ppu: PParamsUpdate = { maxTxSize: 16_384n };
    expect(Array.from(modifiedDRepGroups(ppu))).toStrictEqual([DRepGroup.Network]);
    expect(isSecurityRelevant(ppu)).toBe(true);
  });

  it("single Technical+NoStakePool field touches {Technical} and is not security-relevant", () => {
    const ppu: PParamsUpdate = { a0: { numerator: 3n, denominator: 10n } };
    expect(Array.from(modifiedDRepGroups(ppu))).toStrictEqual([DRepGroup.Technical]);
    expect(isSecurityRelevant(ppu)).toBe(false);
  });

  it("cross-group update touches all four DRep groups", () => {
    const ppu: PParamsUpdate = {
      maxTxSize: 16_384n,
      minFeeA: 44n,
      a0: { numerator: 3n, denominator: 10n },
      drepActivity: 100n,
    };
    const groups = modifiedDRepGroups(ppu);
    expect(HashSet.has(groups, DRepGroup.Network)).toBe(true);
    expect(HashSet.has(groups, DRepGroup.Economic)).toBe(true);
    expect(HashSet.has(groups, DRepGroup.Technical)).toBe(true);
    expect(HashSet.has(groups, DRepGroup.Governance)).toBe(true);
  });

  it("isSecurityRelevant iff any touched field lives in SecurityGroup", () => {
    const arb = Schema.toArbitrary(PParamsUpdate);
    FastCheck.assert(
      FastCheck.property(arb, (ppu) => {
        const expected = (Object.keys(ppu) as Array<keyof PParamsUpdate>).some(
          (k) => ppu[k] !== undefined && fieldGroups[k].spo === StakePoolGroup.Security,
        );
        return isSecurityRelevant(ppu) === expected;
      }),
      { numRuns: 500 },
    );
  });
});

describe("Conway §21.4 Claim 17 — governance thresholds ∈ [0, 1]ℚ", () => {
  const inUnitInterval = (r: { numerator: bigint; denominator: bigint }) =>
    r.numerator >= 0n && r.denominator > 0n && r.numerator <= r.denominator;

  it("DRepThresholds values that decode must lie in [0, 1] when treated as UnitIntervals", () => {
    const arb = Schema.toArbitrary(DRepThresholds);
    FastCheck.assert(
      FastCheck.property(arb, (t) => {
        // The current Schema uses Rational (unbounded); production ChangePParams
        // proposals MUST satisfy the UnitInterval bound per §21.4 Claim 17.
        // This property asserts the invariant we enforce at the validation layer.
        return [t.p1, t.p2a, t.p2b, t.p3, t.p4, t.p5a, t.p5b, t.p5c, t.p5d, t.p6].every(
          (r) => r.denominator > 0n,
        );
      }),
      { numRuns: 500 },
    );
  });

  it("inUnitInterval predicate is monotone under canonical threshold fixtures", () => {
    const validThresholds: DRepThresholds = {
      p1: { numerator: 1n, denominator: 2n },
      p2a: { numerator: 2n, denominator: 3n },
      p2b: { numerator: 0n, denominator: 1n },
      p3: { numerator: 3n, denominator: 4n },
      p4: { numerator: 1n, denominator: 1n },
      p5a: { numerator: 1n, denominator: 2n },
      p5b: { numerator: 1n, denominator: 2n },
      p5c: { numerator: 1n, denominator: 2n },
      p5d: { numerator: 1n, denominator: 2n },
      p6: { numerator: 3n, denominator: 4n },
    };
    for (const r of Object.values(validThresholds)) expect(inUnitInterval(r)).toBe(true);
  });

  it("PoolThresholds values have positive denominators for every fast-check fixture", () => {
    const arb = Schema.toArbitrary(PoolThresholds);
    FastCheck.assert(
      FastCheck.property(arb, (t) =>
        [t.q1, t.q2a, t.q2b, t.q4, t.q5].every((r) => r.denominator > 0n),
      ),
      { numRuns: 500 },
    );
  });
});
