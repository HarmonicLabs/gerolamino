/**
 * MultiEraBlock / MultiEraHeader tagged-union dispatch tests.
 *
 * Exercises `.match()`, `.guards`, `.isAnyOf` per the Phase 6 plan requirement
 * that header dispatch go through tagged-union primitives rather than
 * property access or `_tag === ` checks.
 */
import { describe, it, expect } from "@effect/vitest";
import {
  MultiEraBlock,
  MultiEraHeader,
  isByronBlock,
  isPostByronBlock,
  isByronHeader,
  isShelleyLikeHeader,
  isBabbageLikeHeader,
  Era,
} from "..";

// ---------------------------------------------------------------------------
// Minimal synthetic fixtures — only the fields the type guards observe.
// Full-structure coverage lives in full-snapshot-coverage.test.ts (real blocks).
// ---------------------------------------------------------------------------

const zeroHash32 = new Uint8Array(32);
const zeroHash64 = new Uint8Array(64);

const shelleyLikeHeader = {
  blockNo: 100n,
  slot: 200n,
  prevHash: zeroHash32,
  issuerVKey: zeroHash32,
  vrfVKey: zeroHash32,
  nonceVrf: { output: zeroHash32, proof: zeroHash64 },
  vrfResult: { output: zeroHash32, proof: zeroHash64 },
  bodySize: 1000n,
  bodyHash: zeroHash32,
  opCert: { hotVKey: zeroHash32, seqNo: 1n, kesPeriod: 2n, sigma: zeroHash64 },
  protocolVersion: { major: 2n, minor: 0n },
  kesSignature: zeroHash64,
};

const babbageLikeHeader = {
  blockNo: 1000n,
  slot: 2000n,
  prevHash: zeroHash32,
  issuerVKey: zeroHash32,
  vrfVKey: zeroHash32,
  vrfResult: { output: zeroHash32, proof: zeroHash64 },
  bodySize: 1000n,
  bodyHash: zeroHash32,
  opCert: { hotVKey: zeroHash32, seqNo: 1n, kesPeriod: 2n, sigma: zeroHash64 },
  protocolVersion: { major: 8n, minor: 0n },
  kesSignature: zeroHash64,
};

// ---------------------------------------------------------------------------
// MultiEraHeader dispatch
// ---------------------------------------------------------------------------

describe("MultiEraHeader", () => {
  it("byronEbb variant is recognized as Byron only", () => {
    const h: MultiEraHeader = {
      _tag: "byronEbb",
      protocolMagic: 764824073n,
      prevHash: zeroHash32,
      epoch: 0n,
      blockNo: 0n,
    };
    expect(isByronHeader(h)).toBe(true);
    expect(isShelleyLikeHeader(h)).toBe(false);
    expect(isBabbageLikeHeader(h)).toBe(false);
  });

  it("byron main variant is recognized as Byron only", () => {
    const h: MultiEraHeader = {
      _tag: "byron",
      protocolMagic: 764824073n,
      prevHash: zeroHash32,
      epoch: 0n,
      slotInEpoch: 10n,
      blockNo: 1n,
    };
    expect(isByronHeader(h)).toBe(true);
    expect(isShelleyLikeHeader(h)).toBe(false);
  });

  it("shelley/allegra/mary/alonzo are Shelley-like", () => {
    for (const tag of ["shelley", "allegra", "mary", "alonzo"] as const) {
      const h: MultiEraHeader = { _tag: tag, ...shelleyLikeHeader };
      expect(isShelleyLikeHeader(h)).toBe(true);
      expect(isByronHeader(h)).toBe(false);
      expect(isBabbageLikeHeader(h)).toBe(false);
    }
  });

  it("babbage/conway are Babbage-like", () => {
    for (const tag of ["babbage", "conway"] as const) {
      const h: MultiEraHeader = { _tag: tag, ...babbageLikeHeader };
      expect(isBabbageLikeHeader(h)).toBe(true);
      expect(isShelleyLikeHeader(h)).toBe(false);
      expect(isByronHeader(h)).toBe(false);
    }
  });

  it(".match() dispatches exhaustively across all 8 variants", () => {
    const headers: MultiEraHeader[] = [
      { _tag: "byronEbb", protocolMagic: 1n, prevHash: zeroHash32, epoch: 0n, blockNo: 0n },
      {
        _tag: "byron",
        protocolMagic: 1n,
        prevHash: zeroHash32,
        epoch: 0n,
        slotInEpoch: 0n,
        blockNo: 1n,
      },
      { _tag: "shelley", ...shelleyLikeHeader },
      { _tag: "allegra", ...shelleyLikeHeader },
      { _tag: "mary", ...shelleyLikeHeader },
      { _tag: "alonzo", ...shelleyLikeHeader },
      { _tag: "babbage", ...babbageLikeHeader },
      { _tag: "conway", ...babbageLikeHeader },
    ];

    const describe = MultiEraHeader.match({
      byronEbb: () => "byron-ebb",
      byron: () => "byron-main",
      shelley: () => "shelley",
      allegra: () => "allegra",
      mary: () => "mary",
      alonzo: () => "alonzo",
      babbage: () => "babbage",
      conway: () => "conway",
    });

    expect(headers.map(describe)).toEqual([
      "byron-ebb",
      "byron-main",
      "shelley",
      "allegra",
      "mary",
      "alonzo",
      "babbage",
      "conway",
    ]);
  });
});

// ---------------------------------------------------------------------------
// MultiEraBlock dispatch
// ---------------------------------------------------------------------------

describe("MultiEraBlock", () => {
  it("byron variant passes isByronBlock, fails isPostByronBlock", () => {
    const b: MultiEraBlock = {
      _tag: "byron",
      raw: new Uint8Array([0x01, 0x02, 0x03]),
      multiEraHeader: {
        _tag: "byronEbb",
        protocolMagic: 1n,
        prevHash: zeroHash32,
        epoch: 0n,
        blockNo: 0n,
      },
    };
    expect(isByronBlock(b)).toBe(true);
    expect(isPostByronBlock(b)).toBe(false);
  });

  it("postByron variant passes isPostByronBlock, fails isByronBlock", () => {
    const b: MultiEraBlock = {
      _tag: "postByron",
      era: Era.Conway,
      header: {
        blockNo: 100n,
        slot: 200n,
        prevHash: zeroHash32,
        issuerVKey: zeroHash32,
        vrfVKey: zeroHash32,
        vrfResult: { output: zeroHash32, proof: zeroHash64 },
        bodySize: 1000n,
        bodyHash: zeroHash32,
        opCert: { hotVKey: zeroHash32, seqNo: 1n, kesPeriod: 2n, sigma: zeroHash64 },
        protocolVersion: { major: 8n, minor: 0n },
        kesSignature: zeroHash64,
      },
      multiEraHeader: { _tag: "conway", ...babbageLikeHeader },
      txBodies: [],
      witnessSetsCbor: new Uint8Array(0),
      auxDataCbor: new Uint8Array(0),
    };
    expect(isPostByronBlock(b)).toBe(true);
    expect(isByronBlock(b)).toBe(false);
  });

  it(".match() dispatches across both variants", () => {
    const byronB: MultiEraBlock = {
      _tag: "byron",
      raw: new Uint8Array([0x01]),
      multiEraHeader: {
        _tag: "byron",
        protocolMagic: 1n,
        prevHash: zeroHash32,
        epoch: 0n,
        slotInEpoch: 0n,
        blockNo: 1n,
      },
    };
    const postB: MultiEraBlock = {
      _tag: "postByron",
      era: Era.Shelley,
      header: {
        blockNo: 100n,
        slot: 200n,
        prevHash: zeroHash32,
        issuerVKey: zeroHash32,
        vrfVKey: zeroHash32,
        nonceVrf: { output: zeroHash32, proof: zeroHash64 },
        vrfResult: { output: zeroHash32, proof: zeroHash64 },
        bodySize: 1000n,
        bodyHash: zeroHash32,
        opCert: { hotVKey: zeroHash32, seqNo: 1n, kesPeriod: 2n, sigma: zeroHash64 },
        protocolVersion: { major: 2n, minor: 0n },
        kesSignature: zeroHash64,
      },
      multiEraHeader: { _tag: "shelley", ...shelleyLikeHeader },
      txBodies: [],
      witnessSetsCbor: new Uint8Array(0),
      auxDataCbor: new Uint8Array(0),
    };

    const summarize = MultiEraBlock.match({
      byron: (b) => `byron(${b.raw.length} bytes)`,
      postByron: (b) => `${Era[b.era]}(${b.txBodies.length} txs)`,
    });

    expect(summarize(byronB)).toBe("byron(1 bytes)");
    expect(summarize(postB)).toBe("Shelley(0 txs)");
  });

  it(".guards narrows type for variant-specific access", () => {
    const b: MultiEraBlock = {
      _tag: "postByron",
      era: Era.Babbage,
      header: {
        blockNo: 100n,
        slot: 200n,
        prevHash: zeroHash32,
        issuerVKey: zeroHash32,
        vrfVKey: zeroHash32,
        vrfResult: { output: zeroHash32, proof: zeroHash64 },
        bodySize: 1000n,
        bodyHash: zeroHash32,
        opCert: { hotVKey: zeroHash32, seqNo: 1n, kesPeriod: 2n, sigma: zeroHash64 },
        protocolVersion: { major: 8n, minor: 0n },
        kesSignature: zeroHash64,
      },
      multiEraHeader: { _tag: "babbage", ...babbageLikeHeader },
      txBodies: [],
      witnessSetsCbor: new Uint8Array(0),
      auxDataCbor: new Uint8Array(0),
    };
    if (MultiEraBlock.guards.postByron(b)) {
      expect(b.era).toBe(Era.Babbage);
      expect(b.txBodies.length).toBe(0);
    } else {
      throw new Error("expected postByron variant");
    }
  });
});
