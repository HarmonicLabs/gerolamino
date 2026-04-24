/**
 * Block body validation — integrity checks on block contents.
 *
 * Body hash uses a Merkle-like double-hash scheme (per Haskell hashShelleySegWits /
 * hashAlonzoSegWits in cardano-ledger BlockBody/Internal.hs):
 *
 * Shelley/Allegra/Mary (3 segments):
 *   bodyHash = blake2b-256(blake2b-256(txBodies) || blake2b-256(witnesses) || blake2b-256(auxData))
 * Alonzo/Babbage/Conway (4 segments):
 *   bodyHash = blake2b-256(blake2b-256(txBodies) || blake2b-256(witnesses) || blake2b-256(auxData) || blake2b-256(invalidTxs))
 *
 * Each segment is individually hashed, then the 32-byte hashes are concatenated and hashed again.
 *
 * Uses the `Crypto` service for blake2b (abstracted, testable, platform-independent).
 * Assumes canonical CBOR encoding (per Cardano spec).
 */
import { Effect, Equal, Metric, Schema } from "effect";
import { parseSync, encodeSync, CborKinds, CborValue } from "codecs";
import { Crypto } from "wasm-utils";
import { concat } from "../util";
import { BlockValidationFailed, SPAN } from "../observability.ts";

/** Block-body validation buckets — `VerifyBodyHash` (Merkle body-hash check)
 * + `BlockSizeLimit` (protocol-param ceiling). Narrowed from `Schema.String`
 * to let `Match.value(e.assertion)` stay exhaustive. */
export const BlockAssertion = Schema.Literals(["VerifyBodyHash", "BlockSizeLimit"]);
export type BlockAssertion = typeof BlockAssertion.Type;

export class BlockValidationError extends Schema.TaggedErrorClass<BlockValidationError>()(
  "BlockValidationError",
  {
    assertion: BlockAssertion,
    cause: Schema.Defect,
  },
) {}

/**
 * Module-level combinator: wrap a `CryptoOpError` (or any other unknown
 * failure) into a `BlockValidationError` with `assertion: "VerifyBodyHash"`.
 * Kept out of the `Effect.gen` body so each blake2b pipeline in `verifyBodyHash`
 * reads as a one-liner instead of capturing the helper in-scope.
 */
const verifyBodyHashErr = (cause: unknown) =>
  new BlockValidationError({ assertion: "VerifyBodyHash", cause });

/**
 * Verify the block body hash matches the header's declared bodyHash.
 *
 * Extracts body components from block CBOR, re-encodes each, concatenates,
 * and hashes with blake2b-256. Skips Byron blocks (era 0-1).
 */
export const verifyBodyHash = (
  blockCbor: Uint8Array,
  declaredBodyHash: Uint8Array,
): Effect.Effect<void, BlockValidationError, Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto;

    const top = parseSync(blockCbor);
    if (!CborValue.guards[CborKinds.Array](top) || top.items.length < 2)
      return yield* Effect.fail(
        new BlockValidationError({
          assertion: "VerifyBodyHash",
          cause: "Invalid block CBOR: expected [era, blockBody]",
        }),
      );

    const eraNum = top.items[0]!;
    if (!CborValue.guards[CborKinds.UInt](eraNum) || eraNum.num <= 1n) return; // Byron — no body hash to verify

    const blockBody = top.items[1]!;
    if (!CborValue.guards[CborKinds.Array](blockBody) || blockBody.items.length < 4)
      return yield* Effect.fail(
        new BlockValidationError({
          assertion: "VerifyBodyHash",
          cause: `Invalid block body: expected >= 4 elements, got ${
            CborValue.guards[CborKinds.Array](blockBody) ? blockBody.items.length : "non-array"
          }`,
        }),
      );

    // Body = [header, txBodies, witnesses, auxData, invalidTxs?]
    // Merkle-like double-hash: hash each segment individually, then hash the concatenation of hashes.
    // Per Haskell hashShelleySegWits / hashAlonzoSegWits (cardano-ledger BlockBody/Internal.hs).
    const txBodiesHash = yield* crypto
      .blake2b256(encodeSync(blockBody.items[1]!))
      .pipe(Effect.mapError(verifyBodyHashErr));
    const witnessesHash = yield* crypto
      .blake2b256(encodeSync(blockBody.items[2]!))
      .pipe(Effect.mapError(verifyBodyHashErr));
    const auxDataHash = yield* crypto
      .blake2b256(encodeSync(blockBody.items[3]!))
      .pipe(Effect.mapError(verifyBodyHashErr));

    // Alonzo+ (era >= 4) includes invalidTxs as 5th element
    const hashConcat =
      blockBody.items.length >= 5
        ? concat(
            txBodiesHash,
            witnessesHash,
            auxDataHash,
            yield* crypto
              .blake2b256(encodeSync(blockBody.items[4]!))
              .pipe(Effect.mapError(verifyBodyHashErr)),
          )
        : concat(txBodiesHash, witnessesHash, auxDataHash);

    const computedHash = yield* crypto
      .blake2b256(hashConcat)
      .pipe(Effect.mapError(verifyBodyHashErr));
    if (!Equal.equals(computedHash, declaredBodyHash))
      return yield* Effect.fail(
        new BlockValidationError({
          assertion: "VerifyBodyHash",
          cause: `Body hash mismatch: expected ${declaredBodyHash.toHex()}, got ${computedHash.toHex()}`,
        }),
      );
  });

/**
 * Validate a block's body integrity.
 *   1. Body hash matches header declaration
 *   2. Block size within limit (skipped if maxBlockBodySize = 0)
 */
export const validateBlock = (
  blockCbor: Uint8Array,
  declaredBodyHash: Uint8Array,
  maxBlockBodySize = 0,
): Effect.Effect<void, BlockValidationError, Crypto> =>
  Effect.gen(function* () {
    yield* verifyBodyHash(blockCbor, declaredBodyHash);

    if (maxBlockBodySize > 0 && blockCbor.byteLength > maxBlockBodySize) {
      yield* Effect.fail(
        new BlockValidationError({
          assertion: "BlockSizeLimit",
          cause: `Block size ${blockCbor.byteLength} exceeds max ${maxBlockBodySize}`,
        }),
      );
    }
  }).pipe(
    Effect.tapError(() => Metric.update(BlockValidationFailed, 1)),
    Effect.withSpan(SPAN.ValidateBody, {
      attributes: { "block.size_bytes": blockCbor.byteLength },
    }),
  );
