import { describe, it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { encodeSync } from "cbor-schema";
import { CborKinds, type CborSchemaType } from "cbor-schema";
import {
  Coin,
  Slot,
  Epoch,
  Ix,
  CoinBytes,
  SlotBytes,
  EpochBytes,
  IxBytes,
  Network,
  NetworkBytes,
  NetworkSchema,
  Rational,
  RationalBytes,
  UnitInterval,
  ExUnits,
  ExUnitsBytes,
} from "../lib/core/primitives.ts";

describe("Branded primitives", () => {
  it.effect("Coin accepts non-negative bigint", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(Coin)(42n);
      expect(decoded).toBe(42n);
    }),
  );

  it.effect("Coin rejects negative bigint", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Coin)(-1n).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("Slot accepts zero", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(Slot)(0n);
      expect(decoded).toBe(0n);
    }),
  );
});

describe("Network", () => {
  it.effect("accepts valid enum values", () =>
    Effect.gen(function* () {
      const testnet = yield* Schema.decodeUnknownEffect(NetworkSchema)(Network.Testnet);
      expect(testnet).toBe(Network.Testnet);
      const mainnet = yield* Schema.decodeUnknownEffect(NetworkSchema)(Network.Mainnet);
      expect(mainnet).toBe(Network.Mainnet);
    }),
  );
});

describe("Rational", () => {
  it.effect("accepts valid rational", () =>
    Effect.gen(function* () {
      const r = yield* Schema.decodeUnknownEffect(Rational)({ numerator: 1n, denominator: 2n });
      expect(r.numerator).toBe(1n);
      expect(r.denominator).toBe(2n);
    }),
  );

  it.effect("rejects zero denominator", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Rational)({
        numerator: 1n,
        denominator: 0n,
      }).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("UnitInterval", () => {
  it.effect("accepts 1/2", () =>
    Effect.gen(function* () {
      const ui = yield* Schema.decodeUnknownEffect(UnitInterval)({
        numerator: 1n,
        denominator: 2n,
      });
      expect(ui.numerator).toBe(1n);
    }),
  );

  it.effect("rejects 3/2 (> 1)", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(UnitInterval)({
        numerator: 3n,
        denominator: 2n,
      }).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("ExUnits", () => {
  it.effect("accepts valid execution units", () =>
    Effect.gen(function* () {
      const eu = yield* Schema.decodeUnknownEffect(ExUnits)({ mem: 100n, steps: 200n });
      expect(eu.mem).toBe(100n);
      expect(eu.steps).toBe(200n);
    }),
  );
});

describe("CBOR round-trip: Coin", () => {
  it.effect("encode then decode Coin", () =>
    Effect.gen(function* () {
      const original = 1000000n;
      const encoded = yield* Schema.encodeUnknownEffect(CoinBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(CoinBytes)(encoded);
      expect(decoded).toBe(original);
    }),
  );
});

describe("CBOR round-trip: Network", () => {
  it.effect("encode then decode Mainnet", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeUnknownEffect(NetworkBytes)(Network.Mainnet);
      const decoded = yield* Schema.decodeUnknownEffect(NetworkBytes)(encoded);
      expect(decoded).toBe(Network.Mainnet);
    }),
  );
});

describe("CBOR round-trip: ExUnits", () => {
  it.effect("encode then decode ExUnits", () =>
    Effect.gen(function* () {
      const original = { mem: 500000n, steps: 1000000n };
      const encoded = yield* Schema.encodeUnknownEffect(ExUnitsBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(ExUnitsBytes)(encoded);
      expect(decoded.mem).toBe(original.mem);
      expect(decoded.steps).toBe(original.steps);
    }),
  );
});
