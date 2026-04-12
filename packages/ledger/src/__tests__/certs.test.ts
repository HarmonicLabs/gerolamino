import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { CborKinds, type CborSchemaType } from "cbor-schema";
import {
  DCert,
  CertKind,
  isDelegationCert,
  isRegistrationCert,
  isPoolCert,
  isGovernanceCert,
  decodeDCert,
  encodeDCert,
  CredentialKind,
  DRepKind,
} from "..";

const keyHash = new Uint8Array(28).fill(0x01);
const scriptHash = new Uint8Array(28).fill(0x02);
const poolHash = new Uint8Array(28).fill(0x03);
const hash32 = new Uint8Array(32).fill(0xdd);

function cborCred(kind: number, hash: Uint8Array): CborSchemaType {
  return {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: BigInt(kind) },
      { _tag: CborKinds.Bytes, bytes: hash },
    ],
  };
}

describe("DCert domain predicates", () => {
  const stakeDelegation: DCert = {
    _tag: CertKind.StakeDelegation,
    credential: { _tag: CredentialKind.KeyHash, hash: keyHash },
    poolKeyHash: poolHash,
  };
  const stakeRegistration: DCert = {
    _tag: CertKind.StakeRegistration,
    credential: { _tag: CredentialKind.KeyHash, hash: keyHash },
  };
  const regDRep: DCert = {
    _tag: CertKind.RegDRep,
    credential: { _tag: CredentialKind.KeyHash, hash: keyHash },
    deposit: 0n,
  };
  const poolRegistration: DCert = {
    _tag: CertKind.PoolRegistration,
    poolParams: {
      operator: poolHash,
      vrfKeyHash: hash32,
      pledge: 0n,
      cost: 0n,
      margin: { numerator: 0n, denominator: 1n },
      rewardAccount: new Uint8Array(29),
      owners: [],
      relays: [],
    },
  };

  it("isDelegationCert", () => {
    expect(isDelegationCert(stakeDelegation)).toBe(true);
    expect(isDelegationCert(stakeRegistration)).toBe(false);
  });

  it("isGovernanceCert", () => {
    expect(isGovernanceCert(regDRep)).toBe(true);
    expect(isGovernanceCert(poolRegistration)).toBe(false);
  });
});

describe("DCert CBOR decode/encode", () => {
  it.effect("StakeRegistration round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [{ _tag: CborKinds.UInt, num: 0n }, cborCred(0, keyHash)],
      };
      const decoded = yield* decodeDCert(cbor);
      expect(decoded._tag).toBe(CertKind.StakeRegistration);
      const reEncoded = encodeDCert(decoded);
      expect(reEncoded).toEqual(cbor);
    }),
  );

  it.effect("StakeDelegation round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 2n },
          cborCred(0, keyHash),
          { _tag: CborKinds.Bytes, bytes: poolHash },
        ],
      };
      const decoded = yield* decodeDCert(cbor);
      expect(decoded._tag).toBe(CertKind.StakeDelegation);
      const reEncoded = encodeDCert(decoded);
      expect(reEncoded).toEqual(cbor);
    }),
  );

  it.effect("PoolRetirement round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 4n },
          { _tag: CborKinds.Bytes, bytes: poolHash },
          { _tag: CborKinds.UInt, num: 300n },
        ],
      };
      const decoded = yield* decodeDCert(cbor);
      expect(decoded._tag).toBe(CertKind.PoolRetirement);
      if (DCert.guards[CertKind.PoolRetirement](decoded)) {
        expect(decoded.epoch).toBe(300n);
      }
      const reEncoded = encodeDCert(decoded);
      expect(reEncoded).toEqual(cbor);
    }),
  );

  it.effect("VoteDeleg round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 9n },
          cborCred(0, keyHash),
          { _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 2n }] }, // AlwaysAbstain DRep
        ],
      };
      const decoded = yield* decodeDCert(cbor);
      expect(decoded._tag).toBe(CertKind.VoteDeleg);
      if (DCert.guards[CertKind.VoteDeleg](decoded)) {
        expect(decoded.drep._tag).toBe(DRepKind.AlwaysAbstain);
      }
    }),
  );

  it.effect("AuthCommitteeHot round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [{ _tag: CborKinds.UInt, num: 14n }, cborCred(0, keyHash), cborCred(1, scriptHash)],
      };
      const decoded = yield* decodeDCert(cbor);
      expect(decoded._tag).toBe(CertKind.AuthCommitteeHot);
      if (DCert.guards[CertKind.AuthCommitteeHot](decoded)) {
        expect(decoded.coldCredential._tag).toBe(CredentialKind.KeyHash);
        expect(decoded.hotCredential._tag).toBe(CredentialKind.Script);
      }
      const reEncoded = encodeDCert(decoded);
      expect(reEncoded).toEqual(cbor);
    }),
  );

  it.effect("RegDRep with anchor round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 16n },
          cborCred(0, keyHash),
          { _tag: CborKinds.UInt, num: 500000000n },
          {
            _tag: CborKinds.Array,
            items: [
              { _tag: CborKinds.Text, text: "https://drep.example" },
              { _tag: CborKinds.Bytes, bytes: hash32 },
            ],
          },
        ],
      };
      const decoded = yield* decodeDCert(cbor);
      expect(decoded._tag).toBe(CertKind.RegDRep);
      if (DCert.guards[CertKind.RegDRep](decoded)) {
        expect(decoded.deposit).toBe(500000000n);
        expect(decoded.anchor?.url).toBe("https://drep.example");
      }
    }),
  );
});
