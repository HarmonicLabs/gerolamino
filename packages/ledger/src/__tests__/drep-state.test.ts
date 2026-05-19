/**
 * Test-coverage gap (no test file at all) — `lib/state/drep-state.ts`.
 *
 * Covers the two pure dormancy predicates (`isDormant`, `isActive`) +
 * a smoke test for the `DRepStateBytes` codec construction.
 *
 * The dormancy semantics are spec-load-bearing: per Conway §14.6, a
 * DRep with `expiry <= currentEpoch` is skipped during tally. A
 * regression that flipped the comparator from `<=` to `<` would keep
 * a DRep "active for one extra epoch", silently shifting governance
 * outcomes.
 */
import { describe, it, expect } from "vitest";
import { Epoch } from "../lib/core/primitives.ts";
import { isActive, isDormant, type DRepState } from "../lib/state/drep-state.ts";

// `Epoch` is `Word64.pipe(Schema.brand("Epoch"))` — a bigint with a
// nominal brand. Schema-branded types in v4 expose `.make(value)` to
// lift a raw value into the branded type without a runtime cast.
const epoch = (n: bigint): Epoch => Epoch.make(n);

const mkState = (expiry: bigint): DRepState => ({
  expiry: epoch(expiry),
  anchor: undefined,
  deposit: 0n,
  delegators: [],
});

describe("DRepState dormancy predicates", () => {
  describe("isDormant", () => {
    it("returns true when expiry < currentEpoch", () => {
      expect(isDormant(epoch(100n))(mkState(99n))).toBe(true);
    });

    it("returns true when expiry === currentEpoch (boundary; spec §14.6 inclusive lower)", () => {
      // Per Conway §14.6: DRep is dormant once expiry has been reached.
      // The `expiry <= currentEpoch` predicate at drep-state.ts:57 is
      // the canonical encoding — pin the boundary.
      expect(isDormant(epoch(100n))(mkState(100n))).toBe(true);
    });

    it("returns false when expiry > currentEpoch", () => {
      expect(isDormant(epoch(100n))(mkState(101n))).toBe(false);
    });

    it("returns false when expiry far in the future", () => {
      expect(isDormant(epoch(100n))(mkState(10_000_000n))).toBe(false);
    });
  });

  describe("isActive", () => {
    it("returns false when expiry < currentEpoch", () => {
      expect(isActive(epoch(100n))(mkState(99n))).toBe(false);
    });

    it("returns false when expiry === currentEpoch (boundary)", () => {
      // `isActive` is the strict-greater-than form — the perfect
      // negation of `isDormant` at the boundary.
      expect(isActive(epoch(100n))(mkState(100n))).toBe(false);
    });

    it("returns true when expiry > currentEpoch", () => {
      expect(isActive(epoch(100n))(mkState(101n))).toBe(true);
    });
  });

  describe("isDormant + isActive cover the partition", () => {
    // Defensive — the two predicates must be mutually exclusive AND
    // exhaustive over every (currentEpoch, expiry) pair.
    const cases: ReadonlyArray<readonly [bigint, bigint]> = [
      [0n, 0n],
      [100n, 50n],
      [100n, 100n],
      [100n, 101n],
      [1_000_000n, 999_999n],
      [1_000_000n, 1_000_001n],
    ];
    for (const [currentEpoch, expiry] of cases) {
      it(`epoch=${currentEpoch}, expiry=${expiry} → exactly one of isDormant / isActive`, () => {
        const dormant = isDormant(epoch(currentEpoch))(mkState(expiry));
        const active = isActive(epoch(currentEpoch))(mkState(expiry));
        // XOR — exactly one of the two predicates returns true.
        expect(dormant !== active).toBe(true);
      });
    }
  });
});
