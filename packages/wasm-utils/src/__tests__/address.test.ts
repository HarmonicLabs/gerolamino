/**
 * Test-coverage gap #22 — Address bech32 round-trip + network +
 * type-id + script detection across every Shelley address shape.
 *
 * `wasm-utils` exports 7 raw `address_*` wasm-bindgen functions that
 * are currently zero-tested. Without these tests, a regression in
 * pallas-addresses (or our patched fork) — for example, a wrong
 * header-byte mask in `typeid()`, a missing prefix in `to_bech32()`,
 * or a dropped `network().value()` — would only surface in
 * production at the point a wallet decode silently goes wrong.
 *
 * Fixtures lifted verbatim from pallas-addresses' own test suite
 * (`pallas-addresses/src/lib.rs:760-766`), so they're exercised
 * upstream and known-good.
 */
import { describe, expect, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  CryptoDirect,
  address_from_bech32,
  address_from_hex,
  address_has_script,
  address_network,
  address_to_bech32,
  address_to_hex,
  address_type_id,
} from "../index.ts";

// 8 Shelley address shapes from pallas-addresses' own test fixtures.
// `[bech32, expectedTypeId]` — the type id is the upper nibble of the
// header byte (Cardano CIP-19).
const FIXTURES: ReadonlyArray<readonly [string, number]> = [
  ["addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x", 0],
  ["addr1z8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gten0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs9yc0hh", 1],
  ["addr1yx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerkr0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs2z78ve", 2],
  ["addr1x8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shskhj42g", 3],
  ["addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k", 4],
  ["addr128phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtupnz75xxcrtw79hu", 5],
  ["addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8", 6],
  ["addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx", 7],
];

// `CryptoDirect` runs `initWasm` exactly once for the layer, so any
// raw `address_*` call inside the layer body is safe to invoke
// synchronously even though we don't use `Crypto` here.
layer(CryptoDirect)("Address bech32 codec", (it) => {
  describe("round-trips bech32 → bytes → bech32 byte-equal", () => {
    for (const [bech, typeId] of FIXTURES) {
      it.effect(`type ${typeId}: ${bech.slice(0, 24)}…`, () =>
        Effect.sync(() => {
          const bytes = address_from_bech32(bech);
          expect(bytes).toBeInstanceOf(Uint8Array);
          expect(bytes.length).toBeGreaterThan(0);
          const re = address_to_bech32(bytes);
          expect(re).toBe(bech);
        }),
      );
    }
  });

  describe("hex round-trip is byte-equal to bech32 round-trip", () => {
    for (const [bech, typeId] of FIXTURES) {
      it.effect(`type ${typeId}`, () =>
        Effect.sync(() => {
          const fromBech = address_from_bech32(bech);
          const hex = address_to_hex(fromBech);
          // Hex must be lowercase, with no `0x` prefix — mirrors pallas
          // `to_hex()`. We don't assert the exact hex string (would
          // duplicate the fixture); we assert hex round-trips back to
          // the same bytes.
          expect(hex).toBe(hex.toLowerCase());
          const fromHex = address_from_hex(hex);
          expect(fromHex).toEqual(fromBech);
        }),
      );
    }
  });

  describe("type-id matches header-byte upper nibble", () => {
    for (const [bech, expected] of FIXTURES) {
      it.effect(`type ${expected}`, () =>
        Effect.sync(() => {
          const bytes = address_from_bech32(bech);
          expect(address_type_id(bytes)).toBe(expected);
        }),
      );
    }
  });

  describe("network detection (mainnet = 1)", () => {
    // All addr1… fixtures are mainnet; the bech32 prefix encodes the
    // network in the HRP so `address_network()` should agree across
    // every shape.
    for (const [bech, typeId] of FIXTURES) {
      it.effect(`type ${typeId} reports network=1`, () =>
        Effect.sync(() => {
          const bytes = address_from_bech32(bech);
          expect(address_network(bytes)).toBe(1);
        }),
      );
    }
  });

  describe("script detection per CIP-19 type table", () => {
    // CIP-19: typeId 0/2/4/6 = key payment; 1/3/5/7 = script payment.
    // `has_script` returns true if either credential is a script.
    // Type 2 has a script-stake (key payment + script stake) so still
    // counts as has_script=true.
    const expectedHasScript: Record<number, boolean> = {
      0: false, // key + key
      1: true, // script + key
      2: true, // key + script
      3: true, // script + script
      4: false, // key + pointer (no script)
      5: true, // script + pointer
      6: false, // key only (enterprise)
      7: true, // script only (enterprise)
    };
    for (const [bech, typeId] of FIXTURES) {
      it.effect(`type ${typeId} has_script=${expectedHasScript[typeId]}`, () =>
        Effect.sync(() => {
          const bytes = address_from_bech32(bech);
          expect(address_has_script(bytes)).toBe(expectedHasScript[typeId]);
        }),
      );
    }
  });

  describe("error path", () => {
    it.effect("address_from_bech32 throws on garbage input", () =>
      Effect.sync(() => {
        expect(() => address_from_bech32("not-a-real-bech32")).toThrow();
      }),
    );

    it.effect("address_from_hex throws on odd-length hex", () =>
      Effect.sync(() => {
        expect(() => address_from_hex("abc")).toThrow();
      }),
    );

    it.effect("address_to_bech32 throws on too-short bytes", () =>
      Effect.sync(() => {
        expect(() => address_to_bech32(new Uint8Array([0x00]))).toThrow();
      }),
    );
  });
});
