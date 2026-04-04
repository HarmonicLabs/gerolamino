/**
 * Shared CBOR construction and extraction helpers.
 * Centralizes helpers previously duplicated across tx.ts, certs.ts, pool.ts, value.ts, script.ts.
 *
 * Extraction helpers (expectArray, expectUint, etc.) follow the gold-standard
 * pattern from new-epoch-state.ts: each returns Effect<T, SchemaIssue.Issue>,
 * designed for composition with Effect.gen + yield*.
 */
import { Effect, Option, SchemaIssue } from "effect";
import { CborKinds, type CborSchemaType } from "cbor-schema";

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

export const nullVal: CborSchemaType = { _tag: CborKinds.Simple, value: null };

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
  if (cbor._tag === CborKinds.Array) return cbor.items;
  if (cbor._tag === CborKinds.Tag && cbor.tag === 258n && cbor.data._tag === CborKinds.Array) {
    return cbor.data.items;
  }
  return undefined;
}

/**
 * Encodes items as a CBOR set, optionally wrapped in Tag(258) for Conway.
 */
export function encodeCborSet(
  items: ReadonlyArray<CborSchemaType>,
  useTag258: boolean,
): CborSchemaType {
  const array: CborSchemaType = { _tag: CborKinds.Array, items: [...items] };
  return useTag258 ? { _tag: CborKinds.Tag, tag: 258n, data: array } : array;
}

// ---------------------------------------------------------------------------
// CBOR null detection
// ---------------------------------------------------------------------------

export function decodeCborNull(cbor: CborSchemaType): boolean {
  return cbor._tag === CborKinds.Simple && cbor.value === null;
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
  if (cbor._tag !== CborKinds.Array)
    return Effect.fail(issueAt(cbor, `${ctx}: expected array, got ${cbor._tag}`));
  if (len !== undefined && cbor.items.length !== len)
    return Effect.fail(
      issueAt(cbor, `${ctx}: expected ${len} items, got ${cbor.items.length}`),
    );
  return Effect.succeed(cbor.items);
}

/** Extract a CBOR unsigned integer. Also handles Tag(2, bytes) bignum encoding. */
export function expectUint(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<bigint, SchemaIssue.Issue> {
  if (cbor._tag === CborKinds.UInt) return Effect.succeed(cbor.num);
  // Tag(2) = positive bignum
  if (cbor._tag === CborKinds.Tag && cbor.tag === 2n && cbor.data._tag === CborKinds.Bytes) {
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
  if (cbor._tag === CborKinds.UInt) return Effect.succeed(cbor.num);
  if (cbor._tag === CborKinds.NegInt) return Effect.succeed(cbor.num);
  // Tag(2) = positive bignum
  if (cbor._tag === CborKinds.Tag && cbor.tag === 2n && cbor.data._tag === CborKinds.Bytes) {
    let n = 0n;
    for (const b of cbor.data.bytes) n = (n << 8n) | BigInt(b);
    return Effect.succeed(n);
  }
  // Tag(3) = negative bignum
  if (cbor._tag === CborKinds.Tag && cbor.tag === 3n && cbor.data._tag === CborKinds.Bytes) {
    let n = 0n;
    for (const b of cbor.data.bytes) n = (n << 8n) | BigInt(b);
    return Effect.succeed(-1n - n);
  }
  return Effect.fail(issueAt(cbor, `${ctx}: expected int, got ${cbor._tag}`));
}

/** Extract CBOR bytes, optionally checking exact length. */
export function expectBytes(
  cbor: CborSchemaType,
  ctx: string,
  len?: number,
): Effect.Effect<Uint8Array, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Bytes)
    return Effect.fail(issueAt(cbor, `${ctx}: expected bytes, got ${cbor._tag}`));
  if (len !== undefined && cbor.bytes.length !== len)
    return Effect.fail(
      issueAt(cbor, `${ctx}: expected ${len} bytes, got ${cbor.bytes.length}`),
    );
  return Effect.succeed(cbor.bytes);
}

/** Extract CBOR text string. */
export function expectText(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<string, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Text)
    return Effect.fail(issueAt(cbor, `${ctx}: expected text, got ${cbor._tag}`));
  return Effect.succeed(cbor.text);
}

/** Extract CBOR map entries. */
export function expectMap(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<
  ReadonlyArray<{ k: CborSchemaType; v: CborSchemaType }>,
  SchemaIssue.Issue
> {
  if (cbor._tag !== CborKinds.Map)
    return Effect.fail(issueAt(cbor, `${ctx}: expected map, got ${cbor._tag}`));
  return Effect.succeed(cbor.entries);
}

/** Extract the data inside a CBOR Tag with a specific tag number. */
export function expectTag(
  cbor: CborSchemaType,
  ctx: string,
  tag: bigint,
): Effect.Effect<CborSchemaType, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Tag || cbor.tag !== tag)
    return Effect.fail(
      issueAt(cbor, `${ctx}: expected Tag(${tag}), got ${cbor._tag === CborKinds.Tag ? `Tag(${cbor.tag})` : cbor._tag}`),
    );
  return Effect.succeed(cbor.data);
}

/** Look up a uint key in a CBOR map's entries. Returns undefined if not found. */
export function getMapValue(
  entries: ReadonlyArray<{ k: CborSchemaType; v: CborSchemaType }>,
  key: number,
): CborSchemaType | undefined {
  return entries.find((e) => e.k._tag === CborKinds.UInt && Number(e.k.num) === key)?.v;
}

/** Check if a CBOR value is null (Simple with value null). */
export function isNull(cbor: CborSchemaType): boolean {
  return cbor._tag === CborKinds.Simple && cbor.value === null;
}
