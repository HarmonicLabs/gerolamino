import { describe, expect, test } from "bun:test";
import { isSlotLeader } from "../src/node/leaderMath";

const bytes = (fill: number, len = 32) => new Uint8Array(len).fill(fill);

describe("isSlotLeader (ported from Gerolamo)", () => {
    test("no stake never leads; full stake with a tiny value leads", () => {
        expect(isSlotLeader(bytes(0x00), { num: 0n, den: 1n }, 0.05)).toBe(false);
        expect(isSlotLeader(bytes(0x00), { num: 1n, den: 1n }, 0.05)).toBe(true);
    });
    test("threshold follows σ: a value that is not below 1−(1−f)^σ fails", () => {
        expect(isSlotLeader(bytes(0x0c), { num: 1n, den: 1n }, 0.05)).toBe(true);
        expect(isSlotLeader(bytes(0x0e), { num: 1n, den: 1n }, 0.05)).toBe(false);
        const lo = new Uint8Array(32); lo[1] = 0x20;
        const hi = new Uint8Array(32); hi[1] = 0x22;
        expect(isSlotLeader(lo, { num: 1n, den: 100n }, 0.05)).toBe(true);
        expect(isSlotLeader(hi, { num: 1n, den: 100n }, 0.05)).toBe(false);
    });
    test("64-byte TPraos values use a 2^512 bound", () => {
        expect(isSlotLeader(bytes(0x0c, 64), { num: 1n, den: 1n }, 0.05)).toBe(true);
        expect(isSlotLeader(bytes(0x0e, 64), { num: 1n, den: 1n }, 0.05)).toBe(false);
    });
});
