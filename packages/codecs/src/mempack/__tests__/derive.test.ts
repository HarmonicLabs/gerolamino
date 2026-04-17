import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { MemPackCodec } from "../MemPackCodec";
import { toCodecMemPackBytes } from "../derive/toCodecMemPackBytes";
import { bool, bytes, length, tag, text, varLen, word64 } from "../primitives";

describe("mempack/derive/toCodecMemPackBytes", () => {
  it("lifts a MemPackCodec<bigint> into a Schema.Codec<bigint, Uint8Array>", () => {
    const schema = Schema.BigInt.pipe(
      Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
    );
    const lifted = toCodecMemPackBytes(schema as Schema.Codec<bigint, bigint, never, never>, varLen);

    const value = 1_000_000n;
    const encoded = Effect.runSync(Schema.encodeEffect(lifted)(value));
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = Effect.runSync(Schema.decodeEffect(lifted)(encoded));
    expect(decoded).toBe(value);
  });

  it("lifts a MemPackCodec<boolean>", () => {
    const lifted = toCodecMemPackBytes(
      Schema.Boolean as Schema.Codec<boolean, boolean, never, never>,
      bool,
    );
    const encoded = Effect.runSync(Schema.encodeEffect(lifted)(true));
    expect(encoded).toStrictEqual(Uint8Array.of(1));
    const decoded = Effect.runSync(Schema.decodeEffect(lifted)(Uint8Array.of(0)));
    expect(decoded).toBe(false);
  });

  it("lifts a compound MemPackCodec — { tag, coin } struct via manual composition", () => {
    type Entry = { readonly t: number; readonly n: bigint };
    const entrySchema = Schema.Struct({
      t: Schema.Number,
      n: Schema.BigInt,
    }) as unknown as Schema.Codec<Entry, Entry, never, never>;

    // Manual MemPackCodec<Entry> composition via offset threading — this is
    // exactly what the future `toCodecMemPack` AST walker will do for Struct.
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
    const encoded = Effect.runSync(Schema.encodeEffect(lifted)(value));
    const decoded = Effect.runSync(Schema.decodeEffect(lifted)(encoded));
    expect(decoded).toStrictEqual(value);
  });

  it("surfaces decode failures as structured Issues (not raw throws)", () => {
    const lifted = toCodecMemPackBytes(
      Schema.Boolean as Schema.Codec<boolean, boolean, never, never>,
      bool,
    );
    // Invalid Bool tag (2 is not 0 or 1)
    const result = Effect.runSync(Effect.result(Schema.decodeEffect(lifted)(Uint8Array.of(2))));
    expect(result._tag).toBe("Failure");
  });
});

// Silence a dead-import lint for the MemPack primitives that document the
// intended surface area of the derive module even when not used in a test.
void bytes;
void text;
void length;
void word64;
