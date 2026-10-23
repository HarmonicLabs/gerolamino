import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborSimple, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { LIGHT_QUERY_PROTOCOL, LightQueryClient } from "../src/node/lightQuery";

/** A fake multiplexer whose "relay" answers light queries; replies can be split across mux payloads. */
function fakeRelay(opts: { split?: boolean; silent?: boolean } = {}) {
    let deliver: ((b: Uint8Array) => void) | null = null;
    const sent: number[] = [];
    const mux: any = {
        on: (p: number, cb: (b: Uint8Array) => void) => { if (p === LIGHT_QUERY_PROTOCOL) deliver = cb; },
        off: () => { deliver = null; },
        send: (bytes: Uint8Array, h: { protocol: number }) => {
            sent.push(h.protocol);
            if (opts.silent) return;
            const q = (Cbor.parse(bytes) as CborArray).array;
            const tag = Number((q[0] as CborUInt).num);
            let reply: CborObj;
            if (tag === 4) reply = new CborArray([new CborUInt(5), new CborUInt(2), new CborUInt(10)]);
            else if (tag === 0) reply = new CborArray([new CborUInt(1), q[1]!, Number((q[1] as CborUInt).num) === 99 ? new CborSimple(null) : new CborBytes(new Uint8Array(32).fill(7))]);
            else if (tag === 2) reply = new CborArray([new CborUInt(3), q[1]!, new CborUInt(1_000_000n), new CborUInt(50_000_000n), new CborUInt(1), new CborUInt(20)]);
            else if (tag === 6) reply = new CborArray([new CborUInt(7), q[1]!, new CborBytes(new Uint8Array(3000).fill(1)), new CborBytes(new Uint8Array([1, 0, 0, 0, 0])), new CborBytes(new Uint8Array())]);
            else reply = new CborArray([new CborUInt(255)]);
            const out = Cbor.encode(reply).toBuffer();
            queueMicrotask(() => {
                if (opts.split && out.length > 10) { deliver?.(out.subarray(0, 7)); deliver?.(out.subarray(7)); }
                else deliver?.(out);
            });
        },
    };
    return { mux, sent };
}

describe("light-query client", () => {
    test("hello, epoch nonce (and its absence), pool stake and a chunk, with replies split across payloads", async () => {
        const { mux, sent } = fakeRelay({ split: true });
        const lq = new LightQueryClient(mux);
        expect(await lq.supported).toBe(true);
        expect(await lq.epochNonce(1452)).toEqual(new Uint8Array(32).fill(7));
        expect(await lq.epochNonce(99)).toBeNull();
        const st = await lq.poolStake(1452, new Uint8Array(28));
        expect(st).toEqual({ epoch: 1452, poolStake: 1_000_000n, totalActiveStake: 50_000_000n, activeSlotsCoeff: { num: 1n, den: 20n } });
        const ch = await lq.chunk(5);
        expect(ch!.chunk.length).toBe(3000);
        expect(sent.every((p) => p === 7)).toBe(true);
        lq.dispose();
    });

    test("a relay without the protocol is reported unsupported; dispose fails outstanding requests", async () => {
        const { mux } = fakeRelay({ silent: true });
        const lq = new LightQueryClient(mux, 50);
        expect(await lq.supported).toBe(false);
        const lq2 = new LightQueryClient(mux, 10_000);
        const q = lq2.epochNonce(2);
        lq2.dispose();
        await expect(q).rejects.toThrow(/closed/);
    });
});
