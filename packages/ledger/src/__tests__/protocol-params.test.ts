import { describe, it, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { PParams, PParamsUpdate } from "../lib/protocol-params.ts"

describe("PParamsUpdate (all-optional)", () => {
  it.effect("accepts empty update", () =>
    Effect.gen(function* () {
      const update = yield* Schema.decodeUnknownEffect(PParamsUpdate)({})
      // All fields should be undefined
      expect(update.minFeeA).toBeUndefined()
      expect(update.maxBlockBodySize).toBeUndefined()
    }),
  )

  it.effect("accepts partial update", () =>
    Effect.gen(function* () {
      const update = yield* Schema.decodeUnknownEffect(PParamsUpdate)({
        minFeeA: 44n,
        maxTxSize: 16384n,
      })
      expect(update.minFeeA).toBe(44n)
      expect(update.maxTxSize).toBe(16384n)
      expect(update.keyDeposit).toBeUndefined()
    }),
  )
})
