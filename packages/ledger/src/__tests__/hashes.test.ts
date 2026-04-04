import { describe, it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  Hash28,
  Hash32,
  Signature,
  KeyHash,
  ScriptHash,
  PolicyId,
  TxId,
  DataHash,
  Hash28Bytes,
  Hash32Bytes,
  TxIdBytes,
  Bytes28,
  Bytes32,
  HashObj28,
  HashObj32,
  SignatureObj,
  wrapHash28,
  unwrapHash28,
  wrapHash32,
  unwrapHash32,
  wrapSignature,
  unwrapSignature,
} from "../lib/core/hashes.ts";

describe("Hash28 schema", () => {
  it.effect("accepts 28-byte Uint8Array", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(28).fill(0xab);
      const hash = yield* Schema.decodeUnknownEffect(Hash28)(bytes);
      expect(hash.length).toBe(28);
    }),
  );

  it.effect("rejects wrong length", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Hash28)(new Uint8Array(27)).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("Hash32 schema", () => {
  it.effect("accepts 32-byte Uint8Array", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(32).fill(0xcd);
      const hash = yield* Schema.decodeUnknownEffect(Hash32)(bytes);
      expect(hash.length).toBe(32);
    }),
  );

  it.effect("rejects wrong length", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Hash32)(new Uint8Array(31)).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("Signature schema", () => {
  it.effect("accepts 64-byte Uint8Array", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(64).fill(0xef);
      const sig = yield* Schema.decodeUnknownEffect(Signature)(bytes);
      expect(sig.length).toBe(64);
    }),
  );
});

describe("Stacked brands", () => {
  it.effect("KeyHash is a Hash28 subtype", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(28).fill(0x01);
      const kh = yield* Schema.decodeUnknownEffect(KeyHash)(bytes);
      expect(kh.length).toBe(28);
    }),
  );

  it.effect("TxId is a Hash32 subtype", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(32).fill(0x02);
      const txId = yield* Schema.decodeUnknownEffect(TxId)(bytes);
      expect(txId.length).toBe(32);
    }),
  );
});

describe("Bytes28 / Bytes32 (unbranded checked)", () => {
  it.effect("Bytes28 rejects wrong length", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Bytes28)(new Uint8Array(10)).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("Bytes32 accepts correct length", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(32).fill(0xff);
      const result = yield* Schema.decodeUnknownEffect(Bytes32)(bytes);
      expect(result.length).toBe(32);
    }),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// TaggedClass hash wrappers
// ────────────────────────────────────────────────────────────────────────────

describe("HashObj28 (TaggedClass)", () => {
  it("constructs from bytes", () => {
    const bytes = new Uint8Array(28).fill(0xab);
    const h = new HashObj28({ bytes });
    expect(h._tag).toBe("Hash28");
    expect(h.bytes).toEqual(bytes);
  });

  it("rejects wrong length in constructor", () => {
    expect(() => new HashObj28({ bytes: new Uint8Array(10) })).toThrow();
  });

  it("toHex returns lowercase hex", () => {
    const bytes = new Uint8Array(28).fill(0xab);
    const h = new HashObj28({ bytes });
    expect(h.toHex()).toBe("ab".repeat(28));
    expect(h.toHex().length).toBe(56);
  });

  it("fromHex round-trips", () => {
    const hex = "ab".repeat(28);
    const h = HashObj28.fromHex(hex);
    expect(h.toHex()).toBe(hex);
    expect(h.bytes.length).toBe(28);
  });

  it("fromHex strips 0x prefix", () => {
    const hex = "cd".repeat(28);
    const h = HashObj28.fromHex("0x" + hex);
    expect(h.toHex()).toBe(hex);
  });

  it("equals compares bytes structurally", () => {
    const a = new HashObj28({ bytes: new Uint8Array(28).fill(0x01) });
    const b = new HashObj28({ bytes: new Uint8Array(28).fill(0x01) });
    const c = new HashObj28({ bytes: new Uint8Array(28).fill(0x02) });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe("HashObj32 (TaggedClass)", () => {
  it("constructs from bytes", () => {
    const bytes = new Uint8Array(32).fill(0xcd);
    const h = new HashObj32({ bytes });
    expect(h._tag).toBe("Hash32");
    expect(h.bytes).toEqual(bytes);
  });

  it("rejects wrong length in constructor", () => {
    expect(() => new HashObj32({ bytes: new Uint8Array(31) })).toThrow();
  });

  it("toHex returns lowercase hex", () => {
    const bytes = new Uint8Array(32).fill(0xcd);
    const h = new HashObj32({ bytes });
    expect(h.toHex()).toBe("cd".repeat(32));
    expect(h.toHex().length).toBe(64);
  });

  it("fromHex round-trips", () => {
    const hex = "cd".repeat(32);
    const h = HashObj32.fromHex(hex);
    expect(h.toHex()).toBe(hex);
    expect(h.bytes.length).toBe(32);
  });

  it("equals compares bytes structurally", () => {
    const a = new HashObj32({ bytes: new Uint8Array(32).fill(0x01) });
    const b = new HashObj32({ bytes: new Uint8Array(32).fill(0x01) });
    const c = new HashObj32({ bytes: new Uint8Array(32).fill(0x02) });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe("SignatureObj (TaggedClass)", () => {
  it("constructs from bytes", () => {
    const bytes = new Uint8Array(64).fill(0xef);
    const s = new SignatureObj({ bytes });
    expect(s._tag).toBe("Signature");
    expect(s.bytes).toEqual(bytes);
  });

  it("rejects wrong length in constructor", () => {
    expect(() => new SignatureObj({ bytes: new Uint8Array(32) })).toThrow();
  });

  it("toHex returns lowercase hex", () => {
    const bytes = new Uint8Array(64).fill(0xef);
    const s = new SignatureObj({ bytes });
    expect(s.toHex()).toBe("ef".repeat(64));
    expect(s.toHex().length).toBe(128);
  });

  it("fromHex round-trips", () => {
    const hex = "ef".repeat(64);
    const s = SignatureObj.fromHex(hex);
    expect(s.toHex()).toBe(hex);
    expect(s.bytes.length).toBe(64);
  });

  it("equals compares bytes structurally", () => {
    const a = new SignatureObj({ bytes: new Uint8Array(64).fill(0x01) });
    const b = new SignatureObj({ bytes: new Uint8Array(64).fill(0x01) });
    const c = new SignatureObj({ bytes: new Uint8Array(64).fill(0x02) });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe("wrap / unwrap helpers", () => {
  it("wrapHash28 / unwrapHash28 round-trip", () => {
    const raw = new Uint8Array(28).fill(0xaa);
    const wrapped = wrapHash28(raw);
    expect(wrapped).toBeInstanceOf(HashObj28);
    expect(wrapped.toHex()).toBe("aa".repeat(28));
    const unwrapped = unwrapHash28(wrapped);
    expect(unwrapped).toEqual(raw);
  });

  it("wrapHash32 / unwrapHash32 round-trip", () => {
    const raw = new Uint8Array(32).fill(0xbb);
    const wrapped = wrapHash32(raw);
    expect(wrapped).toBeInstanceOf(HashObj32);
    expect(wrapped.toHex()).toBe("bb".repeat(32));
    const unwrapped = unwrapHash32(wrapped);
    expect(unwrapped).toEqual(raw);
  });

  it("wrapSignature / unwrapSignature round-trip", () => {
    const raw = new Uint8Array(64).fill(0xcc);
    const wrapped = wrapSignature(raw);
    expect(wrapped).toBeInstanceOf(SignatureObj);
    expect(wrapped.toHex()).toBe("cc".repeat(64));
    const unwrapped = unwrapSignature(wrapped);
    expect(unwrapped).toEqual(raw);
  });

  it("wrapHash28 rejects wrong length", () => {
    expect(() => wrapHash28(new Uint8Array(10))).toThrow();
  });

  it("wrapHash32 rejects wrong length", () => {
    expect(() => wrapHash32(new Uint8Array(10))).toThrow();
  });

  it("wrapSignature rejects wrong length", () => {
    expect(() => wrapSignature(new Uint8Array(10))).toThrow();
  });
});

describe("Hash CBOR round-trip", () => {
  it.effect("Hash28 round-trip", () =>
    Effect.gen(function* () {
      const original = new Uint8Array(28).fill(0xaa);
      const encoded = yield* Schema.encodeUnknownEffect(Hash28Bytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(Hash28Bytes)(encoded);
      expect(decoded).toEqual(original);
    }),
  );

  it.effect("Hash32 round-trip", () =>
    Effect.gen(function* () {
      const original = new Uint8Array(32).fill(0xbb);
      const encoded = yield* Schema.encodeUnknownEffect(Hash32Bytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(Hash32Bytes)(encoded);
      expect(decoded).toEqual(original);
    }),
  );

  it.effect("TxId round-trip", () =>
    Effect.gen(function* () {
      const original = new Uint8Array(32).fill(0xcc);
      const encoded = yield* Schema.encodeUnknownEffect(TxIdBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(TxIdBytes)(encoded);
      expect(decoded).toEqual(original);
    }),
  );
});
