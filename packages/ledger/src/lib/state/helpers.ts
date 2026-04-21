import {
  Effect,
  HashMap,
  Option,
  Schema,
  SchemaAST as AST,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from "effect";
import {
  type CborLinkFactory,
  CborKinds,
  type CborValue,
  CborValue as CborValueSchema,
} from "codecs";

// ────────────────────────────────────────────────────────────────────────────
// Bytewise comparator for canonical CBOR key ordering (RFC 8949 §4.2.1).
// Lexicographic over the byte sequence — shorter is less only if equal up to
// the shorter's length, otherwise by byte value.
// ────────────────────────────────────────────────────────────────────────────

export const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
};

// ────────────────────────────────────────────────────────────────────────────
// HashMap iteration is HAMT-order, not insertion-order. Re-encoding a HashMap
// field to CBOR must therefore materialise entries and sort them explicitly.
// ES2025 `Array.prototype.toSorted` gives us an immutable copy in one call.
// ────────────────────────────────────────────────────────────────────────────

export const hashMapToSortedEntries = <K, V>(
  map: HashMap.HashMap<K, V>,
  compareKey: (a: K, b: K) => number,
): ReadonlyArray<readonly [K, V]> =>
  Array.from(HashMap.entries(map)).toSorted(([a], [b]) => compareKey(a, b));

// ────────────────────────────────────────────────────────────────────────────
// Internal `invalid` — matches the shape used across compositeLinks. Each
// failure is wrapped in `SchemaIssue.InvalidValue` so that failures compose
// into the rest of the Schema error channel.
// ────────────────────────────────────────────────────────────────────────────

const invalid = <T>(value: T, message: string): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

const failOthers = (expected: string) =>
  ({
    [CborKinds.UInt]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got UInt`),
    [CborKinds.NegInt]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got NegInt`),
    [CborKinds.Bytes]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Bytes`),
    [CborKinds.Text]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Text`),
    [CborKinds.Array]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Array`),
    [CborKinds.Map]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Map`),
    [CborKinds.Tag]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Tag`),
    [CborKinds.Simple]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Simple`),
  }) as const;

// ────────────────────────────────────────────────────────────────────────────
// hashMapCodec — generic CBOR Map ↔ Effect HashMap<K, V> codec.
//
// Canonical encode: sort entries by encoded key bytes (RFC 8949 §4.2.1).
// Decode: HashMap.mutate bulk-insert (O(n) amortized, vs chained O(n log n)).
// ────────────────────────────────────────────────────────────────────────────

export interface HashMapCodecOptions<K, V> {
  readonly typeName: string;
  readonly keyCodec: Schema.Codec<K, CborValue, never, never>;
  readonly valueCodec: Schema.Codec<V, CborValue, never, never>;
  readonly compareKey: (a: K, b: K) => number;
  readonly encodeSortBytes?: (key: K) => Uint8Array | undefined;
}

export const hashMapCodec = <K, V>(
  opts: HashMapCodecOptions<K, V>,
): Schema.declare<HashMap.HashMap<K, V>> => {
  const isHashMap = (u: unknown): u is HashMap.HashMap<K, V> => HashMap.isHashMap(u);

  const link = new AST.Link(
    CborValueSchema.ast,
    SchemaTransformation.transformOrFail<HashMap.HashMap<K, V>, CborValue>({
      decode: CborValueSchema.match({
        ...failOthers(`Map for ${opts.typeName}`),
        [CborKinds.Map]: (cbor) =>
          Effect.gen(function* () {
            const decoded = yield* Effect.all(
              cbor.entries.map((entry) =>
                Effect.all([
                  SchemaParser.decodeEffect(opts.keyCodec)(entry.k),
                  SchemaParser.decodeEffect(opts.valueCodec)(entry.v),
                ]),
              ),
            );
            return HashMap.empty<K, V>().pipe(
              HashMap.mutate((mutable) => {
                for (const [k, v] of decoded) HashMap.set(mutable, k, v);
              }),
            );
          }),
      }),
      encode: (map) =>
        Effect.gen(function* () {
          const entries = hashMapToSortedEntries(map, opts.compareKey);
          const encoded = yield* Effect.all(
            entries.map(([k, v]) =>
              Effect.all([
                SchemaParser.encodeEffect(opts.keyCodec)(k),
                SchemaParser.encodeEffect(opts.valueCodec)(v),
              ]),
            ),
          );
          return CborValueSchema.make({
            _tag: CborKinds.Map,
            entries: encoded.map(([k, v]) => ({ k, v })),
          });
        }),
    }),
  );

  return Schema.declare<HashMap.HashMap<K, V>>(isHashMap).annotate({
    toCborLink: (): ReturnType<CborLinkFactory> => link,
  });
};

// ────────────────────────────────────────────────────────────────────────────
// opaqueCborCodec — pass-through codec for any CborValue subtree. Used for
// state fields that this module does not model structurally (rewardUpdate,
// stashedAVVMAddresses, nonMyopic, chainDepState, proposals, committee,
// drepPulsingState), carrying the raw CborValue forward so consumers can
// re-decode at their own layer without re-parsing the snapshot.
// ────────────────────────────────────────────────────────────────────────────

const opaqueCborLink = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<CborValue, CborValue>({
    decode: Effect.succeed,
    encode: Effect.succeed,
  }),
);

export const OpaqueCbor: Schema.declare<CborValue> = Schema.declare<CborValue>(
  Schema.is(CborValueSchema),
).annotate({ toCborLink: (): ReturnType<CborLinkFactory> => opaqueCborLink });
