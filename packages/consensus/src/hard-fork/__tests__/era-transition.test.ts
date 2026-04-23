import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Era } from "ledger/lib/core/era.ts";
import {
  EraBoundary,
  EraHistory,
  EraHistoryOrderError,
  crossesEraBoundary,
  eraAtSlot,
  validateEraHistory,
} from "../era-transition.ts";

/**
 * Synthetic history covering the four live mainnet transitions:
 *   Byron    → Shelley at slot 4_492_800 (epoch 208)
 *   Shelley  → Allegra at slot 16_588_800 (epoch 236)
 *   Allegra  → Mary    at slot 23_068_800 (epoch 251)
 *   Mary     → Alonzo  at slot 39_916_975 (epoch 290, mainnet Alonzo)
 *   Alonzo   → Babbage at slot 72_316_796 (epoch 365)
 *   Babbage  → Conway  at slot 133_660_799 (epoch 507)
 *
 * These slot/epoch values approximate mainnet constants; exact values
 * aren't part of the type invariants we're testing here.
 */
const mkBoundary = (fromEra: Era, toEra: Era, epoch: bigint, slot: bigint) =>
  new EraBoundary({ fromEra, toEra, epoch, slot });

const mainnetLikeHistory = new EraHistory({
  boundaries: [
    mkBoundary(Era.Byron, Era.Shelley, 208n, 4_492_800n),
    mkBoundary(Era.Shelley, Era.Allegra, 236n, 16_588_800n),
    mkBoundary(Era.Allegra, Era.Mary, 251n, 23_068_800n),
    mkBoundary(Era.Mary, Era.Alonzo, 290n, 39_916_975n),
    mkBoundary(Era.Alonzo, Era.Babbage, 365n, 72_316_796n),
    mkBoundary(Era.Babbage, Era.Conway, 507n, 133_660_799n),
  ],
  currentEra: Era.Conway,
});

describe("EraHistory", () => {
  it.effect("eraAtSlot returns currentEra on empty history", () =>
    Effect.gen(function* () {
      const empty = new EraHistory({ boundaries: [], currentEra: Era.Byron });
      expect(eraAtSlot(empty, 0n)).toBe(Era.Byron);
      expect(eraAtSlot(empty, 1_000_000n)).toBe(Era.Byron);
    }),
  );

  it.effect("eraAtSlot returns fromEra for slots before the first boundary", () =>
    Effect.gen(function* () {
      expect(eraAtSlot(mainnetLikeHistory, 0n)).toBe(Era.Byron);
      expect(eraAtSlot(mainnetLikeHistory, 4_492_799n)).toBe(Era.Byron);
    }),
  );

  it.effect("eraAtSlot returns toEra for the boundary slot itself (new-era semantics)", () =>
    Effect.gen(function* () {
      // Post-translation: the boundary slot is already in the new era
      expect(eraAtSlot(mainnetLikeHistory, 4_492_800n)).toBe(Era.Shelley);
      expect(eraAtSlot(mainnetLikeHistory, 16_588_800n)).toBe(Era.Allegra);
      expect(eraAtSlot(mainnetLikeHistory, 133_660_799n)).toBe(Era.Conway);
    }),
  );

  it.effect("eraAtSlot returns toEra for slots within an era range", () =>
    Effect.gen(function* () {
      expect(eraAtSlot(mainnetLikeHistory, 5_000_000n)).toBe(Era.Shelley);
      expect(eraAtSlot(mainnetLikeHistory, 20_000_000n)).toBe(Era.Allegra);
      expect(eraAtSlot(mainnetLikeHistory, 50_000_000n)).toBe(Era.Alonzo);
      expect(eraAtSlot(mainnetLikeHistory, 100_000_000n)).toBe(Era.Babbage);
      expect(eraAtSlot(mainnetLikeHistory, 200_000_000n)).toBe(Era.Conway);
    }),
  );

  it.effect("crossesEraBoundary detects straddling ranges", () =>
    Effect.gen(function* () {
      expect(crossesEraBoundary(mainnetLikeHistory, 4_000_000n, 5_000_000n)).toBe(true);
      expect(crossesEraBoundary(mainnetLikeHistory, 5_000_000n, 6_000_000n)).toBe(false);
      expect(crossesEraBoundary(mainnetLikeHistory, 0n, 200_000_000n)).toBe(true);
    }),
  );

  it.effect("crossesEraBoundary is false for empty or backward ranges", () =>
    Effect.gen(function* () {
      expect(crossesEraBoundary(mainnetLikeHistory, 5_000_000n, 5_000_000n)).toBe(false);
      expect(crossesEraBoundary(mainnetLikeHistory, 10_000_000n, 5_000_000n)).toBe(false);
    }),
  );

  it.effect("validateEraHistory accepts a well-formed mainnet-like history", () =>
    Effect.gen(function* () {
      expect(validateEraHistory(mainnetLikeHistory)).toBeNull();
    }),
  );

  it.effect("validateEraHistory rejects non-monotonic slots", () =>
    Effect.gen(function* () {
      const bad = new EraHistory({
        boundaries: [
          mkBoundary(Era.Byron, Era.Shelley, 208n, 4_492_800n),
          mkBoundary(Era.Shelley, Era.Allegra, 236n, 4_000_000n), // slot goes backward
        ],
        currentEra: Era.Allegra,
      });
      const err = validateEraHistory(bad);
      expect(err).toBeInstanceOf(EraHistoryOrderError);
      expect(err?.boundaryIndex).toBe(1);
    }),
  );

  it.effect("validateEraHistory rejects non-chaining eras", () =>
    Effect.gen(function* () {
      const bad = new EraHistory({
        boundaries: [
          mkBoundary(Era.Byron, Era.Shelley, 208n, 4_492_800n),
          // jumps from Shelley to Mary directly, skipping Allegra
          mkBoundary(Era.Mary, Era.Alonzo, 290n, 16_588_800n),
        ],
        currentEra: Era.Alonzo,
      });
      const err = validateEraHistory(bad);
      expect(err).toBeInstanceOf(EraHistoryOrderError);
    }),
  );

  it.effect("validateEraHistory rejects currentEra mismatch with last boundary", () =>
    Effect.gen(function* () {
      const bad = new EraHistory({
        boundaries: [mkBoundary(Era.Byron, Era.Shelley, 208n, 4_492_800n)],
        currentEra: Era.Conway, // should be Shelley
      });
      const err = validateEraHistory(bad);
      expect(err).toBeInstanceOf(EraHistoryOrderError);
    }),
  );
});
