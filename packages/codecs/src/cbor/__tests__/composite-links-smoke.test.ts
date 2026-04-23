import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CborKinds, type CborValue } from "../CborValue";
import { toCodecCbor } from "../derive";

const arr = (items: readonly CborValue[]): CborValue => ({ _tag: CborKinds.Array, items });
const u = (n: bigint): CborValue => ({ _tag: CborKinds.UInt, num: n });
const t = (text: string): CborValue => ({ _tag: CborKinds.Text, text });

describe("smoke", () => {
  it.effect("encodes", () =>
    Effect.gen(function* () {
      enum K {
        Zero = 0,
      }
      const S = Schema.Union([Schema.TaggedStruct(K.Zero, { a: Schema.String })]).pipe(
        Schema.toTaggedUnion("_tag"),
      );
      const codec = toCodecCbor(S);
      const encoded = yield* Schema.encodeEffect(codec)({ _tag: K.Zero, a: "hi" });
      expect(encoded).toStrictEqual(arr([u(0n), t("hi")]));
    }),
  );
});
