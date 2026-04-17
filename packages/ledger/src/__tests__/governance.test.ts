import { describe, it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  Vote,
  DRep,
  DRepKind,
  Voter,
  VoterKind,
  Anchor,
  GovAction,
  GovActionKind,
  GovActionId,
  VotingProcedure,
  needsHashProtection,
  isDelayingAction,
  decodeDRep,
  encodeDRep,
  decodeVoter,
  encodeVoter,
  decodeAnchor,
  encodeAnchor,
  decodeGovActionId,
  encodeGovActionId,
  decodeVotingProcedure,
  encodeVotingProcedure,
} from "..";
import { CborKinds, type CborSchemaType, encodeSync, parseSync } from "codecs";

const hash28 = new Uint8Array(28).fill(0xaa);
const hash32 = new Uint8Array(32).fill(0xbb);

describe("DRep schema + tagged union", () => {
  it.effect("accepts KeyHash DRep", () =>
    Effect.gen(function* () {
      const drep = yield* Schema.decodeUnknownEffect(DRep)({
        _tag: DRepKind.KeyHash,
        hash: hash28,
      });
      expect(drep._tag).toBe(DRepKind.KeyHash);
    }),
  );

  it.effect("accepts AlwaysAbstain", () =>
    Effect.gen(function* () {
      const drep = yield* Schema.decodeUnknownEffect(DRep)({ _tag: DRepKind.AlwaysAbstain });
      expect(drep._tag).toBe(DRepKind.AlwaysAbstain);
    }),
  );

  it("guards narrow correctly", () => {
    const drep = { _tag: DRepKind.AlwaysNoConfidence as const };
    expect(DRep.guards[DRepKind.AlwaysNoConfidence](drep)).toBe(true);
    expect(DRep.guards[DRepKind.KeyHash](drep)).toBe(false);
  });

  it("match works", () => {
    const drep = { _tag: DRepKind.Script as const, hash: hash28 };
    const result = DRep.match(drep, {
      [DRepKind.KeyHash]: () => "key",
      [DRepKind.Script]: () => "script",
      [DRepKind.AlwaysAbstain]: () => "abstain",
      [DRepKind.AlwaysNoConfidence]: () => "noconf",
    });
    expect(result).toBe("script");
  });
});

describe("DRep CBOR round-trip", () => {
  it.effect("KeyHash round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 0n },
          { _tag: CborKinds.Bytes, bytes: hash28 },
        ],
      };
      const decoded = yield* decodeDRep(cbor);
      expect(decoded._tag).toBe(DRepKind.KeyHash);
      const reEncoded = encodeDRep(decoded);
      expect(reEncoded).toEqual(cbor);
    }),
  );

  it.effect("AlwaysAbstain round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [{ _tag: CborKinds.UInt, num: 2n }],
      };
      const decoded = yield* decodeDRep(cbor);
      expect(decoded._tag).toBe(DRepKind.AlwaysAbstain);
      const reEncoded = encodeDRep(decoded);
      expect(reEncoded).toEqual(cbor);
    }),
  );
});

describe("GovAction domain predicates", () => {
  it("needsHashProtection", () => {
    expect(needsHashProtection({ _tag: GovActionKind.NoConfidence as const })).toBe(true);
    expect(needsHashProtection({ _tag: GovActionKind.InfoAction as const })).toBe(false);
    expect(
      needsHashProtection({ _tag: GovActionKind.TreasuryWithdrawals as const, withdrawals: [] }),
    ).toBe(false);
  });

  it("isDelayingAction", () => {
    expect(
      isDelayingAction({
        _tag: GovActionKind.HardForkInitiation as const,
        protocolVersion: { major: 9n, minor: 0n },
      }),
    ).toBe(true);
    expect(isDelayingAction({ _tag: GovActionKind.InfoAction as const })).toBe(false);
  });
});

describe("Voter CBOR round-trip", () => {
  it.effect("SPO voter", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 4n },
          { _tag: CborKinds.Bytes, bytes: hash28 },
        ],
      };
      const decoded = yield* decodeVoter(cbor);
      expect(decoded.kind).toBe(VoterKind.SPOKeyHash);
      const reEncoded = encodeVoter(decoded);
      expect(reEncoded).toEqual(cbor);
    }),
  );
});

describe("VotingProcedure CBOR round-trip", () => {
  it.effect("with anchor", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 1n },
          {
            _tag: CborKinds.Array,
            items: [
              { _tag: CborKinds.Text, text: "https://example.com" },
              { _tag: CborKinds.Bytes, bytes: hash32 },
            ],
          },
        ],
      };
      const decoded = yield* decodeVotingProcedure(cbor);
      expect(decoded.vote).toBe(Vote.Yes);
      expect(decoded.anchor?.url).toBe("https://example.com");
    }),
  );

  it.effect("without anchor (null)", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 2n },
          { _tag: CborKinds.Simple, value: null },
        ],
      };
      const decoded = yield* decodeVotingProcedure(cbor);
      expect(decoded.vote).toBe(Vote.Abstain);
      expect(decoded.anchor).toBeUndefined();
    }),
  );
});
