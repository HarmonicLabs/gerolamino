import { describe, it, expect } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { Crypto } from "wasm-utils";
import { verifyBodyHash, validateBlock, BlockValidationError } from "../validate/block";
import { encodeSync, CborKinds } from "codecs";
import type { CborSchemaType } from "codecs";
import { CryptoStub } from "./crypto-stub";

const cryptoLayer = CryptoStub;

const provide = <A>(effect: Effect.Effect<A, BlockValidationError, Crypto>) =>
  effect.pipe(Effect.provide(cryptoLayer));

/** Build a minimal Shelley+ block CBOR with known body components. */
const makeBlockCbor = (
  era: number,
  txBodies: CborSchemaType,
  witnesses: CborSchemaType,
  auxData: CborSchemaType,
  invalidTxs?: CborSchemaType,
): Uint8Array => {
  const header: CborSchemaType = {
    _tag: CborKinds.Array,
    items: [{ _tag: CborKinds.UInt, num: 0n }], // minimal stub header
  };

  const bodyItems: CborSchemaType[] = [header, txBodies, witnesses, auxData];
  if (invalidTxs) bodyItems.push(invalidTxs);

  const block: CborSchemaType = {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: BigInt(era) },
      { _tag: CborKinds.Array, items: bodyItems },
    ],
  };

  return encodeSync(block);
};

/** Compute the expected body hash from components (double-hash Merkle scheme per spec). */
const computeBodyHash = (
  txBodies: CborSchemaType,
  witnesses: CborSchemaType,
  auxData: CborSchemaType,
  invalidTxs?: CborSchemaType,
): Uint8Array => {
  const hash = (data: Uint8Array): Uint8Array => {
    const h = new Bun.CryptoHasher("blake2b256");
    return new Uint8Array(h.update(data).digest().buffer);
  };
  const segHashes = [
    hash(encodeSync(txBodies)),
    hash(encodeSync(witnesses)),
    hash(encodeSync(auxData)),
  ];
  if (invalidTxs) segHashes.push(hash(encodeSync(invalidTxs)));

  let total = 0;
  for (const h of segHashes) total += h.byteLength;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const h of segHashes) {
    combined.set(h, offset);
    offset += h.byteLength;
  }

  return hash(combined);
};

const emptyArray: CborSchemaType = { _tag: CborKinds.Array, items: [] };
const emptyMap: CborSchemaType = { _tag: CborKinds.Map, entries: [] };

describe("verifyBodyHash", () => {
  it.effect("passes with correct body hash (Shelley — 3 components)", () =>
    provide(
      Effect.gen(function* () {
        const txBodies = emptyArray;
        const witnesses = emptyArray;
        const auxData = emptyMap;

        const bodyHash = computeBodyHash(txBodies, witnesses, auxData);
        const blockCbor = makeBlockCbor(2, txBodies, witnesses, auxData);

        const result = yield* Effect.exit(verifyBodyHash(blockCbor, bodyHash));
        expect(Exit.isSuccess(result)).toBe(true);
      }),
    ),
  );

  it.effect("passes with correct body hash (Alonzo+ — 4 components)", () =>
    provide(
      Effect.gen(function* () {
        const txBodies = emptyArray;
        const witnesses = emptyArray;
        const auxData = emptyMap;
        const invalidTxs = emptyArray;

        const bodyHash = computeBodyHash(txBodies, witnesses, auxData, invalidTxs);
        const blockCbor = makeBlockCbor(4, txBodies, witnesses, auxData, invalidTxs);

        const result = yield* Effect.exit(verifyBodyHash(blockCbor, bodyHash));
        expect(Exit.isSuccess(result)).toBe(true);
      }),
    ),
  );

  it.effect("fails with wrong body hash", () =>
    provide(
      Effect.gen(function* () {
        const txBodies = emptyArray;
        const witnesses = emptyArray;
        const auxData = emptyMap;

        const wrongHash = new Uint8Array(32).fill(0xff);
        const blockCbor = makeBlockCbor(2, txBodies, witnesses, auxData);

        const result = yield* Effect.exit(verifyBodyHash(blockCbor, wrongHash));
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.effect("fails with tampered txBodies", () =>
    provide(
      Effect.gen(function* () {
        const txBodies = emptyArray;
        const witnesses = emptyArray;
        const auxData = emptyMap;

        const bodyHash = computeBodyHash(txBodies, witnesses, auxData);

        const tamperedTxBodies: CborSchemaType = {
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 42n }],
        };
        const blockCbor = makeBlockCbor(2, tamperedTxBodies, witnesses, auxData);

        const result = yield* Effect.exit(verifyBodyHash(blockCbor, bodyHash));
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.effect("skips Byron blocks (era 0)", () =>
    provide(
      Effect.gen(function* () {
        const byronBlock: CborSchemaType = {
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 0n },
            { _tag: CborKinds.Bytes, bytes: new Uint8Array(10) },
          ],
        };
        const blockCbor = encodeSync(byronBlock);
        const anyHash = new Uint8Array(32);

        const result = yield* Effect.exit(verifyBodyHash(blockCbor, anyHash));
        expect(Exit.isSuccess(result)).toBe(true);
      }),
    ),
  );

  it.effect("skips EBB blocks (era 1)", () =>
    provide(
      Effect.gen(function* () {
        const ebbBlock: CborSchemaType = {
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 1n },
            { _tag: CborKinds.Bytes, bytes: new Uint8Array(10) },
          ],
        };
        const blockCbor = encodeSync(ebbBlock);
        const anyHash = new Uint8Array(32);

        const result = yield* Effect.exit(verifyBodyHash(blockCbor, anyHash));
        expect(Exit.isSuccess(result)).toBe(true);
      }),
    ),
  );

  it.effect("passes with non-empty transaction bodies", () =>
    provide(
      Effect.gen(function* () {
        const txBody: CborSchemaType = {
          _tag: CborKinds.Map,
          entries: [
            {
              k: { _tag: CborKinds.UInt, num: 0n },
              v: { _tag: CborKinds.Array, items: [] },
            },
            {
              k: { _tag: CborKinds.UInt, num: 1n },
              v: { _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 1000000n }] },
            },
          ],
        };
        const txBodies: CborSchemaType = { _tag: CborKinds.Array, items: [txBody] };
        const witnesses = emptyArray;
        const auxData = emptyMap;
        const invalidTxs = emptyArray;

        const bodyHash = computeBodyHash(txBodies, witnesses, auxData, invalidTxs);
        const blockCbor = makeBlockCbor(6, txBodies, witnesses, auxData, invalidTxs);

        const result = yield* Effect.exit(verifyBodyHash(blockCbor, bodyHash));
        expect(Exit.isSuccess(result)).toBe(true);
      }),
    ),
  );
});

describe("validateBlock", () => {
  it.effect("passes within size limit", () =>
    provide(
      Effect.gen(function* () {
        const txBodies = emptyArray;
        const witnesses = emptyArray;
        const auxData = emptyMap;
        const bodyHash = computeBodyHash(txBodies, witnesses, auxData);
        const blockCbor = makeBlockCbor(2, txBodies, witnesses, auxData);

        const result = yield* Effect.exit(validateBlock(blockCbor, bodyHash, 1_000_000));
        expect(Exit.isSuccess(result)).toBe(true);
      }),
    ),
  );

  it.effect("fails when exceeding size limit", () =>
    provide(
      Effect.gen(function* () {
        const txBodies = emptyArray;
        const witnesses = emptyArray;
        const auxData = emptyMap;
        const bodyHash = computeBodyHash(txBodies, witnesses, auxData);
        const blockCbor = makeBlockCbor(2, txBodies, witnesses, auxData);

        const result = yield* Effect.exit(validateBlock(blockCbor, bodyHash, 1));
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.effect("skips size check when maxBlockBodySize is 0", () =>
    provide(
      Effect.gen(function* () {
        const txBodies = emptyArray;
        const witnesses = emptyArray;
        const auxData = emptyMap;
        const bodyHash = computeBodyHash(txBodies, witnesses, auxData);
        const blockCbor = makeBlockCbor(2, txBodies, witnesses, auxData);

        const result = yield* Effect.exit(validateBlock(blockCbor, bodyHash));
        expect(Exit.isSuccess(result)).toBe(true);
      }),
    ),
  );
});
