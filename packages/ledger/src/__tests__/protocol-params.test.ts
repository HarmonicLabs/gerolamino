import { describe, it, expect, assert } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  PParams,
  PParamsUpdate,
  ShelleyPParams,
  AlonzoPParams,
  BabbagePParams,
  ConwayPParams,
} from "../lib/protocol-params.ts";

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

describe("VariantSchema PParams per-era extraction", () => {
  it("ShelleyPParams has shared fields but not execution units", () => {
    const fields = ShelleyPParams.fields;
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
    assert.isUndefined((fields as Record<string, unknown>).maxTxExUnits);
    assert.isUndefined((fields as Record<string, unknown>).costModels);
    assert.isUndefined((fields as Record<string, unknown>).prices);
    // Conway fields absent
    assert.isUndefined((fields as Record<string, unknown>).poolThresholds);
    assert.isUndefined((fields as Record<string, unknown>).drepDeposit);
  });

  it("AlonzoPParams has execution unit fields but not governance", () => {
    const fields = AlonzoPParams.fields;
    // Shared fields present
    assert.isDefined(fields.maxBlockBodySize);
    assert.isDefined(fields.minFeeA);
    // Alonzo+ fields present
    assert.isDefined(fields.maxTxExUnits);
    assert.isDefined(fields.costModels);
    assert.isDefined(fields.prices);
    assert.isDefined(fields.collateralPercentage);
    // Shelley-only fields absent
    assert.isUndefined((fields as Record<string, unknown>).d);
    assert.isUndefined((fields as Record<string, unknown>).minUTxOValue);
    // Conway fields absent
    assert.isUndefined((fields as Record<string, unknown>).poolThresholds);
    assert.isUndefined((fields as Record<string, unknown>).drepActivity);
  });

  it("ConwayPParams has all fields including governance", () => {
    const fields = ConwayPParams.fields;
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
    assert.isUndefined((fields as Record<string, unknown>).d);
    assert.isUndefined((fields as Record<string, unknown>).minUTxOValue);
  });

  it("BabbagePParams matches AlonzoPParams fields", () => {
    const alonzoKeys = Object.keys(AlonzoPParams.fields).sort();
    const babbageKeys = Object.keys(BabbagePParams.fields).sort();
    assert.deepStrictEqual(babbageKeys, alonzoKeys);
  });
});
