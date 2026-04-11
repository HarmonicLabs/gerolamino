import { describe, it, expect, assert } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  PParams,
  PParamsUpdate,
  ShelleyPParams,
  AlonzoPParams,
  BabbagePParams,
  ConwayPParams,
} from "../lib/protocol-params/protocol-params.ts";

describe("PParamsUpdate (all-optional)", () => {
  it.effect("accepts empty update", () =>
    Effect.gen(function* () {
      const update = yield* Schema.decodeUnknownEffect(PParamsUpdate)({});
      expect(update.minFeeA).toBeUndefined();
      expect(update.maxBlockBodySize).toBeUndefined();
    }),
  );

  it.effect("accepts partial update", () =>
    Effect.gen(function* () {
      const update = yield* Schema.decodeUnknownEffect(PParamsUpdate)({
        minFeeA: 44n,
        maxTxSize: 16384n,
      });
      expect(update.minFeeA).toBe(44n);
      expect(update.maxTxSize).toBe(16384n);
      expect(update.keyDeposit).toBeUndefined();
    }),
  );
});

/** Check that a key is absent from a fields record. */
const fieldKeys = (fields: object): ReadonlyArray<string> => Object.keys(fields);

describe("VariantSchema PParams per-era extraction", () => {
  it("ShelleyPParams has shared fields but not execution units", () => {
    const fields = ShelleyPParams.fields;
    const keys = fieldKeys(fields);
    // Shared fields present
    assert.isDefined(fields.maxBlockBodySize);
    assert.isDefined(fields.minFeeA);
    assert.isDefined(fields.monetaryExpansion);
    assert.isDefined(fields.eMax);
    assert.isDefined(fields.a0);
    // Shelley-only fields present
    assert.isDefined(fields.d);
    assert.isDefined(fields.minUTxOValue);
    // Alonzo+ fields absent
    assert.isFalse(keys.includes("maxTxExUnits"));
    assert.isFalse(keys.includes("costModels"));
    assert.isFalse(keys.includes("prices"));
    // Conway fields absent
    assert.isFalse(keys.includes("poolThresholds"));
    assert.isFalse(keys.includes("drepDeposit"));
  });

  it("AlonzoPParams has execution unit fields but not governance", () => {
    const fields = AlonzoPParams.fields;
    const keys = fieldKeys(fields);
    // Shared fields present
    assert.isDefined(fields.maxBlockBodySize);
    assert.isDefined(fields.minFeeA);
    // Alonzo+ fields present
    assert.isDefined(fields.maxTxExUnits);
    assert.isDefined(fields.costModels);
    assert.isDefined(fields.prices);
    assert.isDefined(fields.collateralPercentage);
    // Shelley-only fields absent
    assert.isFalse(keys.includes("d"));
    assert.isFalse(keys.includes("minUTxOValue"));
    // Conway fields absent
    assert.isFalse(keys.includes("poolThresholds"));
    assert.isFalse(keys.includes("drepActivity"));
  });

  it("ConwayPParams has all fields including governance", () => {
    const fields = ConwayPParams.fields;
    const keys = fieldKeys(fields);
    // Shared fields
    assert.isDefined(fields.maxBlockBodySize);
    // Alonzo+ fields
    assert.isDefined(fields.maxTxExUnits);
    assert.isDefined(fields.costModels);
    // Conway governance fields
    assert.isDefined(fields.poolThresholds);
    assert.isDefined(fields.drepThresholds);
    assert.isDefined(fields.ccMinSize);
    assert.isDefined(fields.drepDeposit);
    assert.isDefined(fields.drepActivity);
    assert.isDefined(fields.govActionDeposit);
    // Shelley-only fields absent in Conway
    assert.isFalse(keys.includes("d"));
    assert.isFalse(keys.includes("minUTxOValue"));
  });

  it("BabbagePParams matches AlonzoPParams fields", () => {
    const alonzoKeys = Object.keys(AlonzoPParams.fields).sort();
    const babbageKeys = Object.keys(BabbagePParams.fields).sort();
    assert.deepStrictEqual(babbageKeys, alonzoKeys);
  });
});
