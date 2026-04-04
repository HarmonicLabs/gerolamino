import { describe, it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Value, ValueBytes, type MultiAssetEntry } from "../lib/value/value.ts";

describe("Value schema", () => {
  it.effect("accepts coin-only value", () =>
    Effect.gen(function* () {
      const v = yield* Schema.decodeUnknownEffect(Value)({ coin: 1000000n });
      expect(v.coin).toBe(1000000n);
      expect(v.multiAsset).toBeUndefined();
    }),
  );

  it.effect("accepts multi-asset value", () =>
    Effect.gen(function* () {
      const policy = new Uint8Array(28).fill(0xab);
      const name = new Uint8Array(4).fill(0x01);
      const v = yield* Schema.decodeUnknownEffect(Value)({
        coin: 2000000n,
        multiAsset: [{ policy, assets: [{ name, quantity: 100n }] }],
      });
      expect(v.coin).toBe(2000000n);
      expect(v.multiAsset).toHaveLength(1);
    }),
  );
});

describe("Value CBOR round-trip", () => {
  it.effect("coin-only round-trip", () =>
    Effect.gen(function* () {
      const original = { coin: 5000000n };
      const encoded = yield* Schema.encodeUnknownEffect(ValueBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(ValueBytes)(encoded);
      expect(decoded.coin).toBe(5000000n);
      expect(decoded.multiAsset).toBeUndefined();
    }),
  );

  it.effect("multi-asset round-trip", () =>
    Effect.gen(function* () {
      const policy = new Uint8Array(28).fill(0xcd);
      const name1 = new Uint8Array(3).fill(0x41);
      const name2 = new Uint8Array(0);
      const original = {
        coin: 3000000n,
        multiAsset: [
          {
            policy,
            assets: [
              { name: name1, quantity: 50n },
              { name: name2, quantity: 1000n },
            ],
          },
        ],
      };
      const encoded = yield* Schema.encodeUnknownEffect(ValueBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(ValueBytes)(encoded);
      expect(decoded.coin).toBe(3000000n);
      expect(decoded.multiAsset).toHaveLength(1);
      expect(decoded.multiAsset![0]!.policy).toEqual(policy);
      expect(decoded.multiAsset![0]!.assets).toHaveLength(2);
      expect(decoded.multiAsset![0]!.assets[0]!.quantity).toBe(50n);
    }),
  );
});
