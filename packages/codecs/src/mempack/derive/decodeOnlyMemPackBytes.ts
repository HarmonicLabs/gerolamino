import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect";

/**
 * Lift a decode-only MemPack reader (`(bytes: Uint8Array) => T`) into a
 * `Schema.Codec<T, Uint8Array<ArrayBufferLike>>`. The encode side fails with
 * a structured `Issue` explaining that encoding isn't implemented.
 *
 * Use this for wire formats where only the decode direction has a reference
 * implementation — e.g., Cardano's LMDB/V2LSM UTxO storage layout, where the
 * Haskell node is the sole writer and downstream JS code only reads.
 *
 * Prefer `toCodecMemPackBytes(schema, memPackCodec)` whenever a full
 * `MemPackCodec<T>` (pack + unpack) is available — that lifts both directions
 * and plugs into Effect's standard encode/decode pipelines transparently.
 */
export const decodeOnlyMemPackBytes = <T>(
  typeName: string,
  schema: Schema.Codec<T, T, never, never>,
  decode: (bytes: Uint8Array) => T,
): Schema.Codec<T, Uint8Array<ArrayBufferLike>, never, never> =>
  Schema.Uint8Array.pipe(
    Schema.decodeTo(
      schema,
      SchemaTransformation.transformOrFail({
        decode: (bytes, _options) =>
          Effect.try({
            try: () => decode(bytes),
            catch: (cause) =>
              new SchemaIssue.InvalidValue(Option.some(bytes), {
                message: `MemPack decode (${typeName}) failed: ${String(cause)}`,
              }),
          }),
        encode: (value, _options) =>
          Effect.fail(
            new SchemaIssue.InvalidValue(Option.some(value), {
              message: `MemPack encode (${typeName}) not implemented: decode-only codec`,
            }),
          ),
      }),
    ),
  );
