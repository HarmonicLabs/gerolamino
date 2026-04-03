import { describe, it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  Timelock,
  TimelockKind,
  TimelockBytes,
  type TimelockType,
  Script,
  ScriptKind,
  decodeTimelock,
  encodeTimelock,
} from "../lib/script.ts";

const testKeyHash = new Uint8Array(28).fill(0xaa);

describe("Timelock schema", () => {
  it.effect("accepts RequireSig", () =>
    Effect.gen(function* () {
      const tl = yield* Schema.decodeUnknownEffect(Timelock)({
        _tag: TimelockKind.RequireSig,
        keyHash: testKeyHash,
      });
      expect(tl._tag).toBe(TimelockKind.RequireSig);
    }),
  );

  it.effect("accepts nested RequireAllOf", () =>
    Effect.gen(function* () {
      const tl = yield* Schema.decodeUnknownEffect(Timelock)({
        _tag: TimelockKind.RequireAllOf,
        scripts: [
          { _tag: TimelockKind.RequireSig, keyHash: testKeyHash },
          { _tag: TimelockKind.RequireTimeStart, slot: 1000n },
        ],
      });
      expect(tl._tag).toBe(TimelockKind.RequireAllOf);
      if (tl._tag === TimelockKind.RequireAllOf) {
        expect(tl.scripts).toHaveLength(2);
      }
    }),
  );
});

describe("Timelock CBOR round-trip", () => {
  it.effect("RequireSig round-trip", () =>
    Effect.gen(function* () {
      const original: TimelockType = { _tag: TimelockKind.RequireSig, keyHash: testKeyHash };
      const encoded = yield* Schema.encodeUnknownEffect(TimelockBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(TimelockBytes)(encoded);
      expect(decoded._tag).toBe(TimelockKind.RequireSig);
      if (decoded._tag === TimelockKind.RequireSig) {
        expect(decoded.keyHash).toEqual(testKeyHash);
      }
    }),
  );

  it.effect("RequireTimeExpire round-trip", () =>
    Effect.gen(function* () {
      const original: TimelockType = { _tag: TimelockKind.RequireTimeExpire, slot: 42000000n };
      const encoded = yield* Schema.encodeUnknownEffect(TimelockBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(TimelockBytes)(encoded);
      expect(decoded._tag).toBe(TimelockKind.RequireTimeExpire);
      if (decoded._tag === TimelockKind.RequireTimeExpire) {
        expect(decoded.slot).toBe(42000000n);
      }
    }),
  );

  it.effect("nested RequireMOf round-trip", () =>
    Effect.gen(function* () {
      const original: TimelockType = {
        _tag: TimelockKind.RequireMOf,
        required: 2,
        scripts: [
          { _tag: TimelockKind.RequireSig, keyHash: testKeyHash },
          { _tag: TimelockKind.RequireSig, keyHash: new Uint8Array(28).fill(0xbb) },
          { _tag: TimelockKind.RequireTimeStart, slot: 500n },
        ],
      };
      const encoded = yield* Schema.encodeUnknownEffect(TimelockBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(TimelockBytes)(encoded);
      expect(decoded._tag).toBe(TimelockKind.RequireMOf);
      if (decoded._tag === TimelockKind.RequireMOf) {
        expect(decoded.required).toBe(2);
        expect(decoded.scripts).toHaveLength(3);
      }
    }),
  );
});

describe("Script schema", () => {
  it.effect("accepts NativeScript", () =>
    Effect.gen(function* () {
      const s = yield* Schema.decodeUnknownEffect(Script)({
        _tag: ScriptKind.NativeScript,
        script: { _tag: TimelockKind.RequireSig, keyHash: testKeyHash },
      });
      expect(s._tag).toBe(ScriptKind.NativeScript);
    }),
  );

  it.effect("accepts PlutusV3", () =>
    Effect.gen(function* () {
      const s = yield* Schema.decodeUnknownEffect(Script)({
        _tag: ScriptKind.PlutusV3,
        bytes: new Uint8Array([0x01, 0x02, 0x03]),
      });
      expect(s._tag).toBe(ScriptKind.PlutusV3);
    }),
  );
});

describe("Timelock.match", () => {
  it("exhaustive pattern matching on timelock", () => {
    const tl: TimelockType = { _tag: TimelockKind.RequireTimeStart, slot: 100n };
    const result = Timelock.match(tl, {
      [TimelockKind.RequireAllOf]: () => "allOf",
      [TimelockKind.RequireAnyOf]: () => "anyOf",
      [TimelockKind.RequireMOf]: () => "mOf",
      [TimelockKind.RequireSig]: () => "sig",
      [TimelockKind.RequireTimeStart]: (t) => `start:${t.slot}`,
      [TimelockKind.RequireTimeExpire]: () => "expire",
    });
    expect(result).toBe("start:100");
  });
});
