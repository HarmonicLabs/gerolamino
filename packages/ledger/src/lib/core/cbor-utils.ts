/**
 * Shared CBOR construction and extraction helpers.
 * Centralizes helpers previously duplicated across tx.ts, certs.ts, pool.ts, value.ts, script.ts.
 *
 * Extraction helpers (expectArray, expectUint, etc.) follow the gold-standard
 * pattern from new-epoch-state.ts: each returns Effect<T, SchemaIssue.Issue>,
 * designed for composition with Effect.gen + yield*.
 *
 * Narrowing on CBOR variants goes through `CborValueSchema.guards[...]` rather
 * than raw `cbor._tag === CborKinds.X` checks so that the walker's schema
 * remains the single source of truth for CBOR shape.
 */
import { Effect, Option, SchemaIssue } from "effect";
import { CborKinds, CborValue as CborValueSchema, type CborSchemaType } from "codecs";

// ---------------------------------------------------------------------------
// CBOR value constructors
// ---------------------------------------------------------------------------

export const uint = (n: bigint | number): CborSchemaType => ({
  _tag: CborKinds.UInt,
  num: BigInt(n),
});

export const negInt = (num: bigint): CborSchemaType => ({ _tag: CborKinds.NegInt, num });

export const cborBytes = (bytes: Uint8Array): CborSchemaType => ({ _tag: CborKinds.Bytes, bytes });

export const cborText = (text: string): CborSchemaType => ({ _tag: CborKinds.Text, text });

export const arr = (...items: ReadonlyArray<CborSchemaType>): CborSchemaType => ({
  _tag: CborKinds.Array,
  items: [...items],
});

export function mapEntry(
  key: number,
  v: CborSchemaType | undefined,
): ReadonlyArray<{ k: CborSchemaType; v: CborSchemaType }> {
  return v !== undefined ? [{ k: uint(key), v }] : [];
}

// ---------------------------------------------------------------------------
// Tag(258) CBOR set handling
// Conway wraps certain collections in Tag(258, Array) to denote mathematical
// sets. Pre-Conway uses bare Arrays. These utilities handle both.
// ---------------------------------------------------------------------------

/**
 * Unwraps both bare `Array` and `Tag(258, Array)` into their items.
 * Returns undefined if the input is neither format.
 */
export function getCborSet(cbor: CborSchemaType): ReadonlyArray<CborSchemaType> | undefined {
  if (CborValueSchema.guards[CborKinds.Array](cbor)) return cbor.items;
  if (
    CborValueSchema.guards[CborKinds.Tag](cbor) &&
    cbor.tag === 258n &&
    CborValueSchema.guards[CborKinds.Array](cbor.data)
  ) {
    return cbor.data.items;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// CBOR extraction helpers — for use with Effect.gen + yield*
//
// Each returns Effect<T, SchemaIssue.Issue> for composition:
//   const items = yield* expectArray(cbor, "TxIn", 2)
//   const txId  = yield* expectBytes(items[0]!, "TxIn.txId", 32)
// ---------------------------------------------------------------------------

function issueAt(cbor: CborSchemaType, message: string): SchemaIssue.Issue {
  return new SchemaIssue.InvalidValue(Option.some(cbor), { message });
}

/** Extract a CBOR Array's items, optionally checking exact length. */
export function expectArray(
  cbor: CborSchemaType,
  ctx: string,
  len?: number,
): Effect.Effect<ReadonlyArray<CborSchemaType>, SchemaIssue.Issue> {
  if (!CborValueSchema.guards[CborKinds.Array](cbor))
    return Effect.fail(issueAt(cbor, `${ctx}: expected array, got ${cbor._tag}`));
  if (len !== undefined && cbor.items.length !== len)
    return Effect.fail(issueAt(cbor, `${ctx}: expected ${len} items, got ${cbor.items.length}`));
  return Effect.succeed(cbor.items);
}

/** Extract a CBOR unsigned integer. Also handles Tag(2, bytes) bignum encoding. */
export function expectUint(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<bigint, SchemaIssue.Issue> {
  if (CborValueSchema.guards[CborKinds.UInt](cbor)) return Effect.succeed(cbor.num);
  // Tag(2) = positive bignum
  if (
    CborValueSchema.guards[CborKinds.Tag](cbor) &&
    cbor.tag === 2n &&
    CborValueSchema.guards[CborKinds.Bytes](cbor.data)
  ) {
    let n = 0n;
    for (const b of cbor.data.bytes) n = (n << 8n) | BigInt(b);
    return Effect.succeed(n);
  }
  return Effect.fail(issueAt(cbor, `${ctx}: expected uint, got ${cbor._tag}`));
}

/** Extract a CBOR integer (unsigned or negative). */
export function expectInt(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<bigint, SchemaIssue.Issue> {
  if (CborValueSchema.guards[CborKinds.UInt](cbor)) return Effect.succeed(cbor.num);
  if (CborValueSchema.guards[CborKinds.NegInt](cbor)) return Effect.succeed(cbor.num);
  if (
    CborValueSchema.guards[CborKinds.Tag](cbor) &&
    CborValueSchema.guards[CborKinds.Bytes](cbor.data)
  ) {
    // Tag(2) = positive bignum; Tag(3) = negative bignum
    if (cbor.tag === 2n) {
      let n = 0n;
      for (const b of cbor.data.bytes) n = (n << 8n) | BigInt(b);
      return Effect.succeed(n);
    }
    if (cbor.tag === 3n) {
      let n = 0n;
      for (const b of cbor.data.bytes) n = (n << 8n) | BigInt(b);
      return Effect.succeed(-1n - n);
    }
  }
  return Effect.fail(issueAt(cbor, `${ctx}: expected int, got ${cbor._tag}`));
}

/** Extract CBOR bytes, optionally checking exact length. */
export function expectBytes(
  cbor: CborSchemaType,
  ctx: string,
  len?: number,
): Effect.Effect<Uint8Array, SchemaIssue.Issue> {
  if (!CborValueSchema.guards[CborKinds.Bytes](cbor))
    return Effect.fail(issueAt(cbor, `${ctx}: expected bytes, got ${cbor._tag}`));
  if (len !== undefined && cbor.bytes.length !== len)
    return Effect.fail(issueAt(cbor, `${ctx}: expected ${len} bytes, got ${cbor.bytes.length}`));
  return Effect.succeed(cbor.bytes);
}

/** Extract CBOR map entries. */
export function expectMap(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<ReadonlyArray<{ k: CborSchemaType; v: CborSchemaType }>, SchemaIssue.Issue> {
  if (!CborValueSchema.guards[CborKinds.Map](cbor))
    return Effect.fail(issueAt(cbor, `${ctx}: expected map, got ${cbor._tag}`));
  return Effect.succeed(cbor.entries);
}

/** Look up a uint key in a CBOR map's entries. Returns undefined if not found. */
export function getMapValue(
  entries: ReadonlyArray<{ k: CborSchemaType; v: CborSchemaType }>,
  key: number,
): CborSchemaType | undefined {
  return entries.find((e) => CborValueSchema.guards[CborKinds.UInt](e.k) && Number(e.k.num) === key)
    ?.v;
}

/** Check if a CBOR value is null (Simple with value null). */
export function isNull(cbor: CborSchemaType): boolean {
  return CborValueSchema.guards[CborKinds.Simple](cbor) && cbor.value === null;
}
