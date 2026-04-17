import { Optic, Schema } from "effect";
import { CborKinds, type CborValue } from "../CborValue";
import { toCodecCbor } from "./toCodecCbor";

// ────────────────────────────────────────────────────────────────────────────
// toCborIso — lift a Schema into an Iso between its domain type T and the
// CBOR IR. Mirrors `Schema.toIso` (Schema.ts:11428) but targets the CBOR IR
// instead of Effect's generic `Iso` slot.
//
//   toCborIso(TxBody)        :: Iso<TxBody, CborValue>
//   .key("fee")              :: Lens<TxBody, CborValue>    (struct → Map entry)
//   .tag(CborKinds.UInt)     :: Optional<TxBody, UIntVariant>
//   .key("num")              :: Optional<TxBody, bigint>
//
// Composition rules (Optic.ts:1419-1430):
//   Iso + Lens   = Lens     (here: toCborIso → .key)
//   Lens + Prism = Optional (here: .key → .tag)
//   Prism + Lens = Optional (.tag → .key)
// ────────────────────────────────────────────────────────────────────────────

export const toCborIso = <T, E>(
  schema: Schema.Codec<T, E, never, never>,
): Optic.Iso<T, CborValue> => {
  const codec = toCodecCbor(schema);
  return Optic.makeIso(Schema.encodeSync(codec), Schema.decodeSync(codec));
};

// ────────────────────────────────────────────────────────────────────────────
// CborValueOptics — 8 variant prisms, one per RFC 8949 major type.
// `.tag()` accepts `AST.LiteralValue` (includes numbers), so `CborKinds.X`
// (numeric enum) passes through directly — no symbol-to-string workaround.
//
// Usage:
//   CborValueOptics.array.key("items").forEach((item) => item)
//     :: Traversal<CborValue, CborValue> — every element in an Array variant
//
//   CborValueOptics.tag.key("data")
//     :: Optional<CborValue, CborValue>  — the payload of a Tag variant
//
//   CborValueOptics.uint.key("num").modify((n) => n * 2n)
//     :: (CborValue) => CborValue — double a UInt (no-op on other kinds)
// ────────────────────────────────────────────────────────────────────────────

export namespace CborValueOptics {
  export const uint = Optic.id<CborValue>().tag(CborKinds.UInt);
  export const negInt = Optic.id<CborValue>().tag(CborKinds.NegInt);
  export const bytes = Optic.id<CborValue>().tag(CborKinds.Bytes);
  export const text = Optic.id<CborValue>().tag(CborKinds.Text);
  export const array = Optic.id<CborValue>().tag(CborKinds.Array);
  export const map = Optic.id<CborValue>().tag(CborKinds.Map);
  export const tag = Optic.id<CborValue>().tag(CborKinds.Tag);
  export const simple = Optic.id<CborValue>().tag(CborKinds.Simple);
}

// ────────────────────────────────────────────────────────────────────────────
// Traversal helpers — pre-built chains for common CBOR navigation patterns.
// These are `Traversal<CborValue, CborValue>` (Optional<CborValue, ReadonlyArray>)
// so `.modifyAll(f)` / `Optic.getAll(t)(s)` work out of the box.
// ────────────────────────────────────────────────────────────────────────────

export namespace CborValueTraversals {
  /** Every element inside a CBOR Array variant. */
  export const arrayItems = CborValueOptics.array
    .key("items")
    .forEach((item) => item);

  /** Every value slot inside a CBOR Map variant (keys untouched). */
  export const mapValues = CborValueOptics.map
    .key("entries")
    .forEach((entry) => entry.key("v"));

  /** Every key slot inside a CBOR Map variant (values untouched). */
  export const mapKeys = CborValueOptics.map
    .key("entries")
    .forEach((entry) => entry.key("k"));

  /** The inner payload of a Tag variant. */
  export const tagData = CborValueOptics.tag.key("data");
}
