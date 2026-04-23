import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import type { MemPackCodec } from "../MemPackCodec";
import { toCodecMemPackBytes } from "../derive/toCodecMemPackBytes";
import { bool, bytes, length, tag, text, varLen, word64 } from "../primitives";

describe("mempack/derive/toCodecMemPackBytes", () => {
  it.effect("lifts a MemPackCodec<bigint> into a Schema.Codec<bigint, Uint8Array>", () =>
    Effect.gen(function* () {
      const schema = Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)));
      const lifted = toCodecMemPackBytes(
        schema as Schema.Codec<bigint, bigint, never, never>,
        varLen,
      );

      const value = 1_000_000n;
      const encoded = yield* Schema.encodeEffect(lifted)(value);
      expect(encoded).toBeInstanceOf(Uint8Array);

      const decoded = yield* Schema.decodeEffect(lifted)(encoded);
      expect(decoded).toBe(value);
    }),
  );

  it.effect("lifts a MemPackCodec<boolean>", () =>
    Effect.gen(function* () {
      const lifted = toCodecMemPackBytes(
        Schema.Boolean as Schema.Codec<boolean, boolean, never, never>,
        bool,
      );
      const encoded = yield* Schema.encodeEffect(lifted)(true);
      expect(encoded).toStrictEqual(Uint8Array.of(1));
      const decoded = yield* Schema.decodeEffect(lifted)(Uint8Array.of(0));
      expect(decoded).toBe(false);
    }),
  );

  it.effect("lifts a compound MemPackCodec — { tag, coin } struct via manual composition", () =>
    Effect.gen(function* () {
      type Entry = { readonly t: number; readonly n: bigint };
      const entrySchema = Schema.Struct({
        t: Schema.Number,
        n: Schema.BigInt,
      }) as unknown as Schema.Codec<Entry, Entry, never, never>;

      const entryCodec: MemPackCodec<Entry> = {
        typeName: "Entry",
        packedByteCount: (e) => tag.packedByteCount(e.t) + varLen.packedByteCount(e.n),
        packInto: (e, view, offset) => {
          const afterTag = tag.packInto(e.t, view, offset);
          return varLen.packInto(e.n, view, afterTag);
        },
        unpack: (view, offset) => {
          const t = tag.unpack(view, offset);
          const n = varLen.unpack(view, t.offset);
          return { value: { t: t.value, n: n.value }, offset: n.offset };
        },
      };

      const lifted = toCodecMemPackBytes(entrySchema, entryCodec);
      const value: Entry = { t: 42, n: 1_000_000_000n };
      const encoded = yield* Schema.encodeEffect(lifted)(value);
      const decoded = yield* Schema.decodeEffect(lifted)(encoded);
      expect(decoded).toStrictEqual(value);
    }),
  );

  it.effect("surfaces decode failures as structured Issues (not raw throws)", () =>
    Effect.gen(function* () {
      const lifted = toCodecMemPackBytes(
        Schema.Boolean as Schema.Codec<boolean, boolean, never, never>,
        bool,
      );
      const exit = yield* Effect.exit(Schema.decodeEffect(lifted)(Uint8Array.of(2)));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

void bytes;
void text;
void length;
void word64;
