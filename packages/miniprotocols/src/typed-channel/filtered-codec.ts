/**
 * `filteredCodec` — narrow a union-wire codec down to a single `_tag`
 * variant.
 *
 * The existing protocol `Schemas` modules expose one combined
 * `Schema.Codec<Union, Uint8Array>` (e.g. `HandshakeMessageBytes` covers
 * every `HandshakeMessage` tag at once). The typed-channel primitive wants
 * per-transition codecs — `Schema.Codec<OneTagOnly, Uint8Array>` — so the
 * `Transition.message` schema fails cleanly when it sees a message that
 * doesn't belong to the transition it models.
 *
 * Architecture: decode bytes via the union codec, refine the decoded
 * value by `_tag`, lift `SchemaError` back into `Issue` for composition
 * inside `Schema.decodeTo`. The encode path is a straight pass-through
 * through the union's encoder (narrow is a subtype of union). Only the
 * tag-mismatch branch emits a bespoke `InvalidValue` with a clear
 * diagnostic; every other failure mode (malformed CBOR, unknown tag,
 * etc.) surfaces the union's own Issue unchanged.
 *
 * No typecasts — the `Schema.declare` predicate narrows the decoded
 * value's type at the `flatMap` boundary, and the encode path relies on
 * the structural subtype `Narrow <: Union` so values flow without
 * `as`-coercion.
 */
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";

/** Narrow a `Codec<Union, Uint8Array>` to a single-tag variant. */
export const filteredCodec = <
  Union extends { readonly _tag: PropertyKey },
  const Tag extends Union["_tag"],
>(
  union: Schema.Codec<Union, Uint8Array>,
  tag: Tag,
): Schema.Codec<Extract<Union, { readonly _tag: Tag }>, Uint8Array> => {
  type Narrow = Extract<Union, { readonly _tag: Tag }>;

  /** Predicate both for `Schema.declare` and for post-decode narrowing. */
  const isNarrow = (u: unknown): u is Narrow =>
    typeof u === "object" && u !== null && (u as { _tag?: PropertyKey })._tag === tag;

  const NarrowSchema = Schema.declare<Narrow>(isNarrow);

  /** `decodeUnknownEffect` fails with `SchemaError`; `decodeTo` wants `Issue`. */
  const asIssue = <A>(
    e: Effect.Effect<A, Schema.SchemaError>,
  ): Effect.Effect<A, SchemaIssue.Issue> => Effect.mapError(e, (err) => err.issue);

  return Schema.Uint8Array.pipe(
    Schema.decodeTo(NarrowSchema, {
      decode: SchemaGetter.transformOrFail<Narrow, Uint8Array>((bytes) =>
        asIssue(Schema.decodeUnknownEffect(union)(bytes)).pipe(
          Effect.flatMap((value) =>
            // `isNarrow` is a user-defined type guard — TS narrows
            // `value: Union` to `Narrow` on the true branch.
            isNarrow(value)
              ? Effect.succeed(value)
              : Effect.fail(
                  new SchemaIssue.InvalidValue(Option.some(value), {
                    message: `filteredCodec: expected tag '${String(tag)}', got '${String(value._tag)}'`,
                  }),
                ),
          ),
        ),
      ),
      // Narrow <: Union (structural subtype by Extract), so the union's
      // encoder accepts a Narrow directly — no widen cast needed.
      encode: SchemaGetter.transformOrFail<Uint8Array, Narrow>((narrow) =>
        asIssue(Schema.encodeUnknownEffect(union)(narrow)),
      ),
    }),
  );
};
