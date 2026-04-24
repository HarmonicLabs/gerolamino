import { BigDecimal } from "effect";
import { CborDecodeError } from "../CborError";
import { CborKinds, type CborValue, CborValue as CborValueSchema } from "../CborValue";

// ────────────────────────────────────────────────────────────────────────────
// CBOR narrowing helpers — runtime-checked discriminated union accessors.
// These are the "expect*" style extractors used throughout ledger/miniprotocols
// for ad-hoc CBOR AST traversal. All dispatches go through the tagged-union
// utilities on `CborValueSchema` (`.guards[...]`), never manual `_tag ===`.
// The guards are user-defined type predicates, so TS narrows at the call site.
// ────────────────────────────────────────────────────────────────────────────

const fail = (kind: CborKinds, gotTag: number, label: string | undefined): never => {
  throw new CborDecodeError({
    operation: "narrow",
    reason: {
      _tag: "NarrowMismatch",
      expectedKind: kind,
      gotTag,
      label,
    },
  });
};

/** Extract the `num` field from a CBOR UInt node. Throws if not UInt. */
export const cborUint = (node: CborValue, label?: string): bigint =>
  CborValueSchema.guards[CborKinds.UInt](node) ? node.num : fail(CborKinds.UInt, node._tag, label);

/** Extract the `num` field from a CBOR NegInt node. Throws if not NegInt. */
export const cborNegInt = (node: CborValue, label?: string): bigint =>
  CborValueSchema.guards[CborKinds.NegInt](node) ? node.num : fail(CborKinds.NegInt, node._tag, label);

/** Extract the `bytes` field from a CBOR Bytes node. Throws if not Bytes. */
export const cborBytes = (node: CborValue, label?: string): Uint8Array =>
  CborValueSchema.guards[CborKinds.Bytes](node) ? node.bytes : fail(CborKinds.Bytes, node._tag, label);

/** Extract the `text` field from a CBOR Text node. Throws if not Text. */
export const cborText = (node: CborValue, label?: string): string =>
  CborValueSchema.guards[CborKinds.Text](node) ? node.text : fail(CborKinds.Text, node._tag, label);

/** Extract the `items` array from a CBOR Array node. Throws if not Array. */
export const cborArray = (node: CborValue, label?: string): readonly CborValue[] =>
  CborValueSchema.guards[CborKinds.Array](node) ? node.items : fail(CborKinds.Array, node._tag, label);

/** Extract the `entries` from a CBOR Map node. Throws if not Map. */
export const cborMap = (
  node: CborValue,
  label?: string,
): readonly { readonly k: CborValue; readonly v: CborValue }[] =>
  CborValueSchema.guards[CborKinds.Map](node) ? node.entries : fail(CborKinds.Map, node._tag, label);

/** Extract the `value` field from a CBOR Simple node. Throws if not Simple. */
export const cborSimple = (
  node: CborValue,
  label?: string,
): boolean | null | BigDecimal.BigDecimal | undefined =>
  CborValueSchema.guards[CborKinds.Simple](node) ? node.value : fail(CborKinds.Simple, node._tag, label);

/** Extract boolean from a CBOR Simple node. Throws if not a boolean Simple. */
export const cborBool = (node: CborValue, label?: string): boolean => {
  if (CborValueSchema.guards[CborKinds.Simple](node) && typeof node.value === "boolean") {
    return node.value;
  }
  throw new CborDecodeError({
    operation: "narrow",
    reason: {
      _tag: "NarrowMismatch",
      expectedKind: CborKinds.Simple,
      gotTag: node._tag,
      label,
    },
  });
};
