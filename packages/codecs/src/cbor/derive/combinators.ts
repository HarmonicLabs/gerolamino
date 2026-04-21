import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { CborBytes } from "../codec/CborBytes";
import { CborKinds, type CborValue, CborValue as CborValueSchema } from "../CborValue";

/**
 * Generic CBOR ↔ Uint8Array codec for any domain schema with hand-written
 * `CborValue` encoder/decoder functions. Collapses the 4-line boilerplate:
 *
 * ```
 * CborBytes.pipe(Schema.decodeTo(Target, {
 *   decode: SchemaGetter.transformOrFail(decodeFn),
 *   encode: SchemaGetter.transformOrFail(encodeFn),
 * }))
 * ```
 *
 * to a one-liner:
 *
 * ```
 * cborCodec(Target, decodeFn, encodeFn)
 * ```
 *
 * Both `decode` and `encode` are fallible (return `Effect<_, SchemaIssue.Issue>`)
 * — useful for domain schemas that carry structural invariants not expressible
 * in Schema checks (tagged-union shapes, multi-era dispatch, set-vs-array
 * polymorphism) and for encoders that compose nested `Schema.encodeEffect`
 * calls. Call sites that compose `Schema.decodeEffect` / `Schema.encodeEffect`
 * downgrade the outer `SchemaError` to `SchemaIssue.Issue` via
 * {@link schemaErrorToIssue} before handing off.
 */
export const cborCodec = <T, E, RD, RE>(
  to: Schema.Codec<T, E, RD, RE>,
  decode: (cbor: CborValue) => Effect.Effect<E, SchemaIssue.Issue>,
  encode: (value: E) => Effect.Effect<CborValue, SchemaIssue.Issue>,
): Schema.Codec<T, Uint8Array, RD, RE> =>
  CborBytes.pipe(
    Schema.decodeTo(to, {
      decode: SchemaGetter.transformOrFail(decode),
      encode: SchemaGetter.transformOrFail(encode),
    }),
  );

/**
 * Downgrade a `Schema.SchemaError` to its inner `SchemaIssue.Issue` at a
 * call-site boundary. `Schema.decodeEffect` and `Schema.encodeEffect` fail
 * with `SchemaError` (tagged `_tag: "SchemaError"`); the `transformOrFail`
 * contract inside {@link cborCodec} requires `Issue`. Use as
 *
 * ```
 * Schema.decodeEffect(Codec)(cbor).pipe(schemaErrorToIssue)
 * ```
 *
 * Backed by `Effect.catchTag("SchemaError", ...)` — the tag is the stable
 * identifier on `SchemaError` instances (see
 * `effect/src/internal/schema/schema.ts`).
 */
export const schemaErrorToIssue = <A, R>(
  self: Effect.Effect<A, Schema.SchemaError, R>,
): Effect.Effect<A, SchemaIssue.Issue, R> =>
  Effect.catchTag(self, "SchemaError", (e) => Effect.fail(e.issue));

/**
 * Sync variant of {@link cborCodec} for legacy decoders whose error path is
 * a thrown JS `Error` rather than an `Effect` failure. The throw is caught
 * and wrapped in `SchemaIssue.InvalidValue` preserving the offending CBOR
 * node as context. Prefer {@link cborCodec} for new code — the Effect-based
 * path carries typed failure information.
 */
export const cborSyncCodec = <T, RD, RE>(
  to: Schema.Codec<T, T, RD, RE>,
  decode: (cbor: CborValue) => T,
  encode: (value: T) => CborValue,
): Schema.Codec<T, Uint8Array, RD, RE> =>
  CborBytes.pipe(
    Schema.decodeTo(to, {
      decode: SchemaGetter.transformOrFail((cbor: CborValue) =>
        Effect.try({
          try: () => decode(cbor),
          catch: (cause) =>
            new SchemaIssue.InvalidValue(Option.some(cbor), { message: String(cause) }),
        }),
      ),
      encode: SchemaGetter.transform(encode),
    }),
  );

// ────────────────────────────────────────────────────────────────────────────
// Schema-level CBOR combinators — compose on top of the `CborBytes` Layer-1
// codec. Downstream packages that define domain `Uint8Array`-typed schemas
// (hashes, signatures, fixed-size payloads) compose them through these
// factories rather than hand-writing
//   `CborSchemaFromBytes.pipe(Schema.decodeTo(Target, { decode: expectBytes, … }))`
// per type. The migration target is a one-liner per domain codec.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Wrap any `Uint8Array`-encoded codec in CBOR Bytes on the wire.
 *
 * Given a target schema whose encoded form is a `Uint8Array` (e.g. a branded
 * or length-checked Uint8Array schema like `Hash28` / `Signature`), returns a
 * codec whose Type mirrors the target's Type and whose Encoded form is the
 * CBOR-framed byte stream. Length / brand checks remain the responsibility
 * of the target schema — this combinator only handles the CBOR framing.
 *
 * ```
 * const Hash28Bytes = cborBytesCodec(Hash28, "Hash28")
 * // ≡ CborSchemaFromBytes.pipe(Schema.decodeTo(Hash28, {
 * //     decode: expectBytes("Hash28"), encode: cborBytes,
 * //   }))
 * ```
 */
export const cborBytesCodec = <T extends Uint8Array, RD, RE>(
  to: Schema.Codec<T, Uint8Array, RD, RE>,
  context: string,
): Schema.Codec<T, Uint8Array, RD, RE> =>
  CborBytes.pipe(
    Schema.decodeTo(to, {
      decode: SchemaGetter.transformOrFail((cbor: CborValue) =>
        CborValueSchema.guards[CborKinds.Bytes](cbor)
          ? Effect.succeed(cbor.bytes)
          : Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(cbor), {
                message: `${context}: expected CBOR Bytes, got ${CborKinds[cbor._tag]}`,
              }),
            ),
      ),
      encode: SchemaGetter.transform(
        (bytes: Uint8Array): CborValue => CborValueSchema.make({ _tag: CborKinds.Bytes, bytes }),
      ),
    }),
  );

/**
 * Wrap any `bigint`-encoded codec in CBOR UInt on the wire.
 *
 * Given a target schema whose encoded form is a `bigint` (typically a
 * branded or checked non-negative bigint like `Coin` / `Slot` / `Epoch`),
 * returns a codec whose Encoded form is a CBOR `UInt` node framed as bytes.
 * The target schema remains responsible for sign / range checks — this
 * combinator only asserts the CBOR major type.
 */
export const cborUintCodec = <T extends bigint, RD, RE>(
  to: Schema.Codec<T, bigint, RD, RE>,
  context: string,
): Schema.Codec<T, Uint8Array, RD, RE> =>
  CborBytes.pipe(
    Schema.decodeTo(to, {
      decode: SchemaGetter.transformOrFail((cbor: CborValue) =>
        CborValueSchema.guards[CborKinds.UInt](cbor)
          ? Effect.succeed(cbor.num)
          : Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(cbor), {
                message: `${context}: expected CBOR UInt, got ${CborKinds[cbor._tag]}`,
              }),
            ),
      ),
      encode: SchemaGetter.transform(
        (n: bigint): CborValue => CborValueSchema.make({ _tag: CborKinds.UInt, num: n }),
      ),
    }),
  );
