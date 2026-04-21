import { describe, it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Value, ValueBytes, type MultiAssetEntry } from "..";

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

  it.effect("multi-asset round-trip (canonical sort on encode)", () =>
    Effect.gen(function* () {
      const policy = new Uint8Array(28).fill(0xcd);
      const name1 = new Uint8Array(3).fill(0x41);
      const name2 = new Uint8Array(0);
      // RFC 8949 canonical: shorter length first. name2 (len 0) sorts before
      // name1 (len 3) regardless of insertion order, so the re-decoded
      // assets[] is re-ordered accordingly.
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
      expect(decoded.multiAsset![0]!.assets[0]!.name).toEqual(name2);
      expect(decoded.multiAsset![0]!.assets[0]!.quantity).toBe(1000n);
      expect(decoded.multiAsset![0]!.assets[1]!.name).toEqual(name1);
      expect(decoded.multiAsset![0]!.assets[1]!.quantity).toBe(50n);
    }),
  );

  it.effect("encode is insertion-order invariant", () =>
    Effect.gen(function* () {
      const policyA = new Uint8Array(28).fill(0x01);
      const policyB = new Uint8Array(28).fill(0x02);
      const nameX = new Uint8Array([0xaa]);
      const nameY = new Uint8Array([0xbb, 0xcc]);

      const forward: MultiAssetEntry[] = [
        {
          policy: policyB,
          assets: [
            { name: nameY, quantity: 200n },
            { name: nameX, quantity: 100n },
          ],
        },
        {
          policy: policyA,
          assets: [{ name: nameX, quantity: 50n }],
        },
      ];
      const reversed: MultiAssetEntry[] = [
        {
          policy: policyA,
          assets: [{ name: nameX, quantity: 50n }],
        },
        {
          policy: policyB,
          assets: [
            { name: nameX, quantity: 100n },
            { name: nameY, quantity: 200n },
          ],
        },
      ];

      const encFwd = yield* Schema.encodeUnknownEffect(ValueBytes)({
        coin: 1n,
        multiAsset: forward,
      });
      const encRev = yield* Schema.encodeUnknownEffect(ValueBytes)({
        coin: 1n,
        multiAsset: reversed,
      });

      expect(encFwd).toStrictEqual(encRev);
    }),
  );
});
