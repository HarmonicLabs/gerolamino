import { describe, it } from "@effect/vitest";
import { Equal, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { DCert, DCertBytes } from "..";

describe("DCert", () => {
  it("round-trips through toCodecCborBytes for every variant", () => {
    const arb = Schema.toArbitrary(DCert);
    const eq = Schema.toEquivalence(DCert);
    FastCheck.assert(
      FastCheck.property(arb, (cert) => {
        const encoded = Schema.encodeUnknownSync(DCertBytes)(cert);
        const decoded = Schema.decodeUnknownSync(DCertBytes)(encoded);
        return eq(cert, decoded);
      }),
      { numRuns: 500 },
    );
  });
});
