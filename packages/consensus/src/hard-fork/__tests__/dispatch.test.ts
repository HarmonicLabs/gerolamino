import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Ref } from "effect";
import { Era } from "ledger/lib/core/era.ts";
import type { MultiEraBlock } from "ledger/lib/block/block.ts";
import { dispatchByEra, EraDispatchError, eraOfBlock, type EraValidators } from "../dispatch.ts";

// Tests exercise the pure-era `dispatchByEra` primitive. Full-block
// routing via `validateBlockByEra` is covered at the integration level
// once real consensus rules land; unit-testing that path requires
// constructing Schema-valid `MultiEraBlock` values, which is heavyweight
// and doesn't add coverage beyond `dispatchByEra` + `MultiEraBlock.match`.

const mkLoggingValidators = (log: Ref.Ref<string[]>): EraValidators<"_", never, never> => ({
  byron: () => Ref.update(log, (xs) => [...xs, "byron"]),
  shelley: () => Ref.update(log, (xs) => [...xs, "shelley"]),
  allegra: () => Ref.update(log, (xs) => [...xs, "allegra"]),
  mary: () => Ref.update(log, (xs) => [...xs, "mary"]),
  alonzo: () => Ref.update(log, (xs) => [...xs, "alonzo"]),
  babbage: () => Ref.update(log, (xs) => [...xs, "babbage"]),
  conway: () => Ref.update(log, (xs) => [...xs, "conway"]),
});

describe("hard-fork/dispatch", () => {
  it.effect("dispatchByEra(Shelley, ...) fires the shelley validator", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<string[]>([]);
      yield* dispatchByEra(Era.Shelley, "_", mkLoggingValidators(log));
      expect(yield* Ref.get(log)).toEqual(["shelley"]);
    }),
  );

  it.effect("dispatchByEra(Conway, ...) fires the conway validator", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<string[]>([]);
      yield* dispatchByEra(Era.Conway, "_", mkLoggingValidators(log));
      expect(yield* Ref.get(log)).toEqual(["conway"]);
    }),
  );

  it.effect("dispatchByEra routes every live era to the right callback", () =>
    Effect.gen(function* () {
      const eras: ReadonlyArray<[Era, string]> = [
        [Era.Byron, "byron"],
        [Era.Shelley, "shelley"],
        [Era.Allegra, "allegra"],
        [Era.Mary, "mary"],
        [Era.Alonzo, "alonzo"],
        [Era.Babbage, "babbage"],
        [Era.Conway, "conway"],
      ];
      for (const [era, expected] of eras) {
        const log = yield* Ref.make<string[]>([]);
        yield* dispatchByEra(era, "_", mkLoggingValidators(log));
        expect(yield* Ref.get(log)).toEqual([expected]);
      }
    }),
  );

  it.effect("dispatchByEra(Byron, ...) with no byron validator no-ops", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<string[]>([]);
      const noByron: EraValidators<"_", never, never> = {
        // byron intentionally omitted
        shelley: () => Ref.update(log, (xs) => [...xs, "shelley"]),
        allegra: () => Ref.update(log, (xs) => [...xs, "allegra"]),
        mary: () => Ref.update(log, (xs) => [...xs, "mary"]),
        alonzo: () => Ref.update(log, (xs) => [...xs, "alonzo"]),
        babbage: () => Ref.update(log, (xs) => [...xs, "babbage"]),
        conway: () => Ref.update(log, (xs) => [...xs, "conway"]),
      };
      yield* dispatchByEra(Era.Byron, "_", noByron);
      expect(yield* Ref.get(log)).toEqual([]);
    }),
  );

  it.effect("dispatchByEra propagates validator errors", () =>
    Effect.gen(function* () {
      class ShelleyBroken extends Error {}
      const validators: EraValidators<"_", ShelleyBroken, never> = {
        byron: () => Effect.void,
        shelley: () => Effect.fail(new ShelleyBroken()),
        allegra: () => Effect.void,
        mary: () => Effect.void,
        alonzo: () => Effect.void,
        babbage: () => Effect.void,
        conway: () => Effect.void,
      };
      const exit = yield* Effect.exit(dispatchByEra(Era.Shelley, "_", validators));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("dispatchByEra passes the input through to the selected validator", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make<number | null>(null);
      const validators: EraValidators<number, never, never> = {
        byron: (n) => Ref.set(received, n),
        shelley: (n) => Ref.set(received, n),
        allegra: (n) => Ref.set(received, n),
        mary: (n) => Ref.set(received, n),
        alonzo: (n) => Ref.set(received, n),
        babbage: (n) => Ref.set(received, n),
        conway: (n) => Ref.set(received, n),
      };
      yield* dispatchByEra(Era.Conway, 42, validators);
      expect(yield* Ref.get(received)).toBe(42);
    }),
  );
});

// `eraOfBlock` extracts the effective era from a `MultiEraBlock`. Pure
// `.match()` over the byron / postByron variants. Tests pin both
// branches end-to-end so a renaming of the variant tag (e.g. "byron"
// → "byronEra") would surface here.
describe("eraOfBlock", () => {
  const zeroHash32 = new Uint8Array(32);
  const zeroHash64 = new Uint8Array(64);

  const byronBlock: MultiEraBlock = {
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

  const postByronBlock = (era: Era, headerTag: string): MultiEraBlock => ({
    _tag: "postByron",
    era,
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
    multiEraHeader: {
      // `eraOfBlock` only reads `_tag` to dispatch — the fixture's
      // shape is intentionally shelley-flavoured even for pre-Babbage
      // eras. `nonceVrf` is required by the pre-Babbage Shelley header
      // variant in the discriminated union (single-VRF Babbage+ drops
      // it); include it as a zero blob so the union narrows.
      _tag: headerTag as "shelley",
      blockNo: 100n,
      slot: 200n,
      prevHash: zeroHash32,
      issuerVKey: zeroHash32,
      vrfVKey: zeroHash32,
      vrfResult: { output: zeroHash32, proof: zeroHash64 },
      nonceVrf: { output: zeroHash32, proof: zeroHash64 },
      bodySize: 1000n,
      bodyHash: zeroHash32,
      opCert: { hotVKey: zeroHash32, seqNo: 1n, kesPeriod: 2n, sigma: zeroHash64 },
      protocolVersion: { major: 8n, minor: 0n },
      kesSignature: zeroHash64,
    },
    txBodies: [],
    witnessSetsCbor: new Uint8Array(0),
    auxDataCbor: new Uint8Array(0),
  });

  it("byron variant → Era.Byron", () => {
    expect(eraOfBlock(byronBlock)).toBe(Era.Byron);
  });

  for (const [era, headerTag] of [
    [Era.Shelley, "shelley"],
    [Era.Allegra, "allegra"],
    [Era.Mary, "mary"],
    [Era.Alonzo, "alonzo"],
    [Era.Babbage, "babbage"],
    [Era.Conway, "conway"],
  ] as const) {
    it(`postByron(${era}) → Era.${era}`, () => {
      expect(eraOfBlock(postByronBlock(era, headerTag))).toBe(era);
    });
  }
});

describe("EraDispatchError construction", () => {
  it("constructs with required message field", () => {
    const err = new EraDispatchError({ message: "boom" });
    expect(err._tag).toBe("EraDispatchError");
    expect(err.message).toBe("boom");
    expect(err.era).toBeUndefined();
  });

  it("preserves optional era field when provided", () => {
    const err = new EraDispatchError({
      message: "history mismatch",
      era: Era.Conway,
    });
    expect(err.era).toBe(Era.Conway);
  });
});
