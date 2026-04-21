import { describe, it, expect } from "@effect/vitest";
import { Effect, Equal, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  Credential,
  CredentialKind,
  CredentialBytes,
  CredentialCbor,
  StateCredential,
  StateCredentialKind,
  StateCredentialBytes,
} from "..";

const testKeyHash = new Uint8Array(28).fill(0xaa);
const testScriptHash = new Uint8Array(28).fill(0xbb);

describe("Credential schema", () => {
  it.effect("accepts KeyHash credential", () =>
    Effect.gen(function* () {
      const cred = yield* Schema.decodeUnknownEffect(Credential)({
        _tag: CredentialKind.KeyHash,
        hash: testKeyHash,
      });
      expect(cred._tag).toBe(CredentialKind.KeyHash);
    }),
  );

  it.effect("accepts Script credential", () =>
    Effect.gen(function* () {
      const cred = yield* Schema.decodeUnknownEffect(Credential)({
        _tag: CredentialKind.Script,
        hash: testScriptHash,
      });
      expect(cred._tag).toBe(CredentialKind.Script);
    }),
  );
});

describe("Credential tagged union utilities", () => {
  it("guards narrow type", () => {
    const cred = { _tag: CredentialKind.KeyHash as const, hash: testKeyHash };
    expect(Credential.guards[CredentialKind.KeyHash](cred)).toBe(true);
    expect(Credential.guards[CredentialKind.Script](cred)).toBe(false);
  });

  it("match extracts fields", () => {
    const cred = { _tag: CredentialKind.KeyHash as const, hash: testKeyHash };
    const result = Credential.match(cred, {
      [CredentialKind.KeyHash]: (_c) => "key" as const,
      [CredentialKind.Script]: (_c) => "script" as const,
    });
    expect(result).toBe("key");
  });

  it("isAnyOf narrows", () => {
    const isKey = Credential.isAnyOf([CredentialKind.KeyHash]);
    const cred = { _tag: CredentialKind.KeyHash as const, hash: testKeyHash };
    expect(isKey(cred)).toBe(true);
  });
});

describe("Credential CBOR round-trip (block/CDDL)", () => {
  it.effect("KeyHash round-trip", () =>
    Effect.gen(function* () {
      const original = { _tag: CredentialKind.KeyHash as const, hash: testKeyHash };
      const encoded = yield* Schema.encodeUnknownEffect(CredentialBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(CredentialBytes)(encoded);
      expect(decoded._tag).toBe(CredentialKind.KeyHash);
      expect(decoded.hash).toEqual(testKeyHash);
    }),
  );

  it.effect("Script round-trip", () =>
    Effect.gen(function* () {
      const original = { _tag: CredentialKind.Script as const, hash: testScriptHash };
      const encoded = yield* Schema.encodeUnknownEffect(CredentialBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(CredentialBytes)(encoded);
      expect(decoded._tag).toBe(CredentialKind.Script);
      expect(decoded.hash).toEqual(testScriptHash);
    }),
  );

  it.effect("CBOR-level codec shims round-trip", () =>
    Effect.gen(function* () {
      const cred = { _tag: CredentialKind.KeyHash as const, hash: testKeyHash };
      const encoded = yield* Schema.encodeEffect(CredentialCbor)(cred);
      const back = yield* Schema.decodeEffect(CredentialCbor)(encoded);
      expect(Equal.equals(cred.hash, back.hash)).toBe(true);
      expect(back._tag).toBe(CredentialKind.KeyHash);
    }),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// State CBOR — tag reversal (0 = Script, 1 = KeyHash). Used only when
// decoding Mithril snapshot state maps; block/CDDL paths use Credential.
// ────────────────────────────────────────────────────────────────────────────

describe("StateCredential CBOR round-trip (ledger state)", () => {
  it.effect("Script (state tag 0) round-trip", () =>
    Effect.gen(function* () {
      const original = { _tag: StateCredentialKind.Script as const, hash: testScriptHash };
      const encoded = yield* Schema.encodeUnknownEffect(StateCredentialBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(StateCredentialBytes)(encoded);
      expect(decoded._tag).toBe(StateCredentialKind.Script);
      expect(decoded.hash).toEqual(testScriptHash);
    }),
  );

  it.effect("KeyHash (state tag 1) round-trip", () =>
    Effect.gen(function* () {
      const original = { _tag: StateCredentialKind.KeyHash as const, hash: testKeyHash };
      const encoded = yield* Schema.encodeUnknownEffect(StateCredentialBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(StateCredentialBytes)(encoded);
      expect(decoded._tag).toBe(StateCredentialKind.KeyHash);
      expect(decoded.hash).toEqual(testKeyHash);
    }),
  );

  it.effect("state vs block tag reversal produces divergent wire bytes", () =>
    Effect.gen(function* () {
      const hash = new Uint8Array(28).fill(0x42);
      const blockKey = { _tag: CredentialKind.KeyHash as const, hash };
      const stateKey = { _tag: StateCredentialKind.KeyHash as const, hash };
      const blockBytes = yield* Schema.encodeUnknownEffect(CredentialBytes)(blockKey);
      const stateBytes = yield* Schema.encodeUnknownEffect(StateCredentialBytes)(stateKey);
      // First byte after CBOR array header is the tag: block = 0, state = 1.
      expect(blockBytes).not.toEqual(stateBytes);
      expect(blockBytes[1]).toBe(0);
      expect(stateBytes[1]).toBe(1);
    }),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Property-based round-trip via Schema.toArbitrary — verifies derivation
// handles every generated (kind, hash) pair. Uses `Equal.equals` for
// byte-wise structural equality on the inner Uint8Array.
// ────────────────────────────────────────────────────────────────────────────

describe("Credential property round-trip", () => {
  it("Credential (block) round-trips via CredentialBytes", () => {
    const arb = Schema.toArbitrary(Credential);
    FastCheck.assert(
      FastCheck.property(arb, (cred) => {
        const encoded = Schema.encodeUnknownSync(CredentialBytes)(cred);
        const decoded = Schema.decodeUnknownSync(CredentialBytes)(encoded);
        return decoded._tag === cred._tag && Equal.equals(decoded.hash, cred.hash);
      }),
      { numRuns: 500 },
    );
  });

  it("StateCredential (state) round-trips via StateCredentialBytes", () => {
    const arb = Schema.toArbitrary(StateCredential);
    FastCheck.assert(
      FastCheck.property(arb, (cred) => {
        const encoded = Schema.encodeUnknownSync(StateCredentialBytes)(cred);
        const decoded = Schema.decodeUnknownSync(StateCredentialBytes)(encoded);
        return decoded._tag === cred._tag && Equal.equals(decoded.hash, cred.hash);
      }),
      { numRuns: 500 },
    );
  });
});
