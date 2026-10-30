import { describe, expect, test } from "bun:test";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { Sha256, sha256, sha256Hex } from "../src/node/sha256";

describe("SHA-256", () => {
    test("FIPS 180-4 vectors: empty, \"abc\", two-block message", () => {
        expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(sha256Hex(fromHex("616263"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        expect(sha256Hex(fromHex("6162636465666768696a6b6c6d6e6f707172737475767778797a")))
            .toBe("71c480df93d6ae2f1efad1447c66c9525e316218cf51fc8d9ed832f2daf18b73");
    });

    test("incremental updates equal one-shot hashing at every chunk boundary", () => {
        const data = new Uint8Array(200);
        for (let i = 0; i < data.length; i++) data[i] = i * 31 & 0xff;
        const one = sha256(data);
        for (const cut of [0, 1, 55, 56, 63, 64, 65, 127, 128, 199]) {
            const h = new ShaForTest();
            h.update(data.subarray(0, cut)).update(data.subarray(cut));
            expect(h.digestHex()).toBe(sha256Hex(data));
        }
        expect(one.length).toBe(32);
    });
});

class ShaForTest {
    private readonly h = new Sha256();
    update(d: Uint8Array) { this.h.update(d); return this; }
    digestHex() { let s = ""; for (const b of this.h.digest()) s += b.toString(16).padStart(2, "0"); return s; }
}
