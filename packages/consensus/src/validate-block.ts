/**
 * Block body validation — integrity checks on block contents.
 *
 * Shelley/Allegra/Mary:
 *   bodyHash = blake2b-256(CBOR(txBodies) || CBOR(witnesses) || CBOR(auxData))
 * Alonzo/Babbage/Conway:
 *   bodyHash = blake2b-256(CBOR(txBodies) || CBOR(witnesses) || CBOR(auxData) || CBOR(invalidTxs))
 *
 * Uses CryptoService for blake2b (abstracted, testable, platform-independent).
 * Assumes canonical CBOR encoding (per Cardano spec).
 */
import { Effect, Schema } from "effect";
import { parseSync, encodeSync, CborKinds } from "cbor-schema";
import { hex, concat } from "./util";
import { CryptoService } from "./crypto";

export class BlockValidationError extends Schema.TaggedErrorClass<BlockValidationError>()(
  "BlockValidationError",
  {
    assertion: Schema.String,
    cause: Schema.Defect,
  },
) {}

/**
 * Verify the block body hash matches the header's declared bodyHash.
 *
 * Extracts body components from block CBOR, re-encodes each, concatenates,
 * and hashes with blake2b-256. Skips Byron blocks (era 0-1).
 */
export const verifyBodyHash = (
  blockCbor: Uint8Array,
  declaredBodyHash: Uint8Array,
): Effect.Effect<void, BlockValidationError, CryptoService> =>
  Effect.gen(function* () {
    const crypto = yield* CryptoService;

    const top = parseSync(blockCbor);
    if (top._tag !== CborKinds.Array || top.items.length < 2)
      return yield* Effect.fail(new BlockValidationError({
        assertion: "VerifyBodyHash",
        cause: "Invalid block CBOR: expected [era, blockBody]",
      }));

    const eraNum = top.items[0]!;
    if (eraNum._tag !== CborKinds.UInt || eraNum.num <= 1n)
      return; // Byron — no body hash to verify

    const blockBody = top.items[1]!;
    if (blockBody._tag !== CborKinds.Array || blockBody.items.length < 4)
      return yield* Effect.fail(new BlockValidationError({
        assertion: "VerifyBodyHash",
        cause: `Invalid block body: expected >= 4 elements, got ${
          blockBody._tag === CborKinds.Array ? blockBody.items.length : "non-array"
        }`,
      }));

    // Body = [header, txBodies, witnesses, auxData, invalidTxs?]
    const txBodiesBytes = encodeSync(blockBody.items[1]!);
    const witnessesBytes = encodeSync(blockBody.items[2]!);
    const auxDataBytes = encodeSync(blockBody.items[3]!);

    // Alonzo+ (era >= 4) includes invalidTxs as 5th element
    const bodyBytes = blockBody.items.length >= 5
      ? concat(txBodiesBytes, witnessesBytes, auxDataBytes, encodeSync(blockBody.items[4]!))
      : concat(txBodiesBytes, witnessesBytes, auxDataBytes);

    const computedHash = crypto.blake2b256(bodyBytes);
    if (hex(computedHash) !== hex(declaredBodyHash))
      return yield* Effect.fail(new BlockValidationError({
        assertion: "VerifyBodyHash",
        cause: `Body hash mismatch: expected ${hex(declaredBodyHash)}, got ${hex(computedHash)}`,
      }));
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
): Effect.Effect<void, BlockValidationError, CryptoService> =>
  Effect.gen(function* () {
    yield* verifyBodyHash(blockCbor, declaredBodyHash);

    if (maxBlockBodySize > 0 && blockCbor.byteLength > maxBlockBodySize) {
      yield* Effect.fail(new BlockValidationError({
        assertion: "BlockSizeLimit",
        cause: `Block size ${blockCbor.byteLength} exceeds max ${maxBlockBodySize}`,
      }));
    }
  });
