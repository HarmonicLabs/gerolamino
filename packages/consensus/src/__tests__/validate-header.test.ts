import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import { validateHeader, HeaderValidationError } from "../validate-header";
import type { BlockHeader, LedgerView } from "../validate-header";

/** Generate a blake2b-256 hash of a pool cold key to get poolId. */
const poolIdFromVk = (vk: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("blake2b256");
  return Array.from(
    new Uint8Array(hasher.update(vk).digest().buffer),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
};

const makeVk = (seed: number): Uint8Array => {
  const vk = new Uint8Array(32);
  vk[0] = seed;
  return vk;
};

const makeHeader = (overrides?: Partial<BlockHeader>): BlockHeader => {
  const issuerVk = makeVk(1);
  return {
    slot: 100n,
    blockNo: 50n,
    hash: new Uint8Array(32),
    prevHash: new Uint8Array(32),
    issuerVk,
    vrfVk: makeVk(2),
    vrfProof: new Uint8Array(80),
    vrfOutput: new Uint8Array(32),
    kesSig: new Uint8Array(448),
    kesPeriod: 10,
    opcertSig: new Uint8Array(64),
    opcertVkHot: new Uint8Array(32),
    opcertSeqNo: 5,
    opcertKesPeriod: 5,
    bodyHash: new Uint8Array(32),
    ...overrides,
  };
};

const makeLedgerView = (
  header: BlockHeader,
  overrides?: Partial<LedgerView>,
): LedgerView => {
  const poolId = poolIdFromVk(header.issuerVk);
  return {
    epochNonce: new Uint8Array(32),
    poolVrfKeys: new Map([[poolId, header.vrfVk]]),
    poolStake: new Map([[poolId, 1_000_000n]]),
    totalStake: 10_000_000n,
    activeSlotsCoeff: 0.05,
    maxKesEvolutions: 62,
    ...overrides,
  };
};

describe("validateHeader", () => {
  it("passes with valid header and matching ledger view", async () => {
    const header = makeHeader();
    const view = makeLedgerView(header);
    const result = await Effect.runPromiseExit(validateHeader(header, view));
    expect(Exit.isSuccess(result)).toBe(true);
  });

  it("fails when pool VRF key is not registered", async () => {
    const header = makeHeader();
    const view = makeLedgerView(header, {
      poolVrfKeys: new Map(), // empty — no registered pools
    });
    const result = await Effect.runPromiseExit(validateHeader(header, view));
    expect(Exit.isFailure(result)).toBe(true);
  });

  it("fails when VRF key doesn't match registered key", async () => {
    const header = makeHeader();
    const poolId = poolIdFromVk(header.issuerVk);
    const view = makeLedgerView(header, {
      poolVrfKeys: new Map([[poolId, makeVk(99)]]), // wrong VRF key
    });
    const result = await Effect.runPromiseExit(validateHeader(header, view));
    expect(Exit.isFailure(result)).toBe(true);
  });

  it("fails when KES period is before opcert start", async () => {
    const header = makeHeader({ kesPeriod: 3, opcertKesPeriod: 10 }); // period < start
    const view = makeLedgerView(header);
    const result = await Effect.runPromiseExit(validateHeader(header, view));
    expect(Exit.isFailure(result)).toBe(true);
  });

  it("fails when KES period exceeds max evolutions", async () => {
    const header = makeHeader({ kesPeriod: 100, opcertKesPeriod: 0 }); // 100 > maxKesEvolutions(62)
    const view = makeLedgerView(header);
    const result = await Effect.runPromiseExit(validateHeader(header, view));
    expect(Exit.isFailure(result)).toBe(true);
  });

  it("fails when opcert sequence number is negative", async () => {
    const header = makeHeader({ opcertSeqNo: -1 });
    const view = makeLedgerView(header);
    const result = await Effect.runPromiseExit(validateHeader(header, view));
    expect(Exit.isFailure(result)).toBe(true);
  });
});
