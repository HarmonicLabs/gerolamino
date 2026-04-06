import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { ConsensusEngine, ConsensusEngineLive } from "../consensus-engine";
import { ChainTip } from "../chain-selection";
import type { BlockHeader, LedgerView } from "../validate-header";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const makeVk = (seed: number): Uint8Array => {
  const vk = new Uint8Array(32);
  vk[0] = seed;
  return vk;
};

const poolIdFromVk = (vk: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("blake2b256");
  return hex(new Uint8Array(hasher.update(vk).digest().buffer));
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

const makeView = (header: BlockHeader): LedgerView => {
  const poolId = poolIdFromVk(header.issuerVk);
  return {
    epochNonce: new Uint8Array(32),
    poolVrfKeys: new Map([[poolId, header.vrfVk]]),
    poolStake: new Map([[poolId, 1_000_000n]]),
    totalStake: 10_000_000n,
    activeSlotsCoeff: 0.05,
    maxKesEvolutions: 62,
  };
};

describe("ConsensusEngine service", () => {
  const run = <A>(effect: Effect.Effect<A, unknown, ConsensusEngine>) =>
    Effect.runPromise(
      effect.pipe(Effect.provideService(ConsensusEngine, ConsensusEngineLive.pipe(Effect.runSync))),
    );

  it("validateHeader passes for valid header", async () => {
    await run(
      Effect.gen(function* () {
        const engine = yield* ConsensusEngine;
        const header = makeHeader();
        const view = makeView(header);
        yield* engine.validateHeader(header, view);
      }),
    );
  });

  it("selectChain prefers longer chain", async () => {
    await run(
      Effect.gen(function* () {
        const engine = yield* ConsensusEngine;
        const ours = new ChainTip({ slot: 100n, blockNo: 50n, hash: new Uint8Array(32) });
        const candidate = new ChainTip({ slot: 101n, blockNo: 51n, hash: new Uint8Array(32) });
        const result = engine.selectChain(ours, candidate, 1, 2160);
        expect(result).toBe(true);
      }),
    );
  });

  it("selectChain rejects fork beyond k", async () => {
    await run(
      Effect.gen(function* () {
        const engine = yield* ConsensusEngine;
        const ours = new ChainTip({ slot: 100n, blockNo: 50n, hash: new Uint8Array(32) });
        const candidate = new ChainTip({ slot: 5000n, blockNo: 100n, hash: new Uint8Array(32) });
        const result = engine.selectChain(ours, candidate, 2161, 2160);
        expect(result).toBe(false);
      }),
    );
  });

  it("getGsmState returns CaughtUp when near tip", async () => {
    await run(
      Effect.gen(function* () {
        const engine = yield* ConsensusEngine;
        const state = engine.getGsmState(100000n, 100010n, 129600n);
        expect(state).toBe("CaughtUp");
      }),
    );
  });

  it("getGsmState returns Syncing when far from tip", async () => {
    await run(
      Effect.gen(function* () {
        const engine = yield* ConsensusEngine;
        const state = engine.getGsmState(100000n, 300000n, 129600n);
        expect(state).toBe("Syncing");
      }),
    );
  });
});
