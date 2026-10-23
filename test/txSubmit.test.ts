import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborMap, CborSimple, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { TxSubmitClient, txIdOf } from "../src/node/txSubmit";
import { TestTxResponder } from "./lib/txResponder";

/** A transaction-shaped CBOR value `[body, witnesses, true, null]` with a distinct body per seed. */
function sampleTx(seed: number): { id: string; bytes: Uint8Array } {
    const body = new CborMap([{ k: new CborUInt(0), v: new CborArray([new CborArray([new CborBytes(new Uint8Array(32).fill(seed)), new CborUInt(0)])]) }, { k: new CborUInt(2), v: new CborUInt(170_000 + seed) }]);
    const bodyBytes = Cbor.encode(body).toBuffer();
    const tx = Cbor.encode(new CborArray([body, new CborMap([]), new CborSimple(true), new CborSimple(null)])).toBuffer();
    return { id: toHex(blake2b_256(bodyBytes)), bytes: tx };
}

/** The client wired to the test responder through a fake multiplexer. */
function pair() {
    const r = new TestTxResponder(5);
    let deliver: ((b: Uint8Array) => void) | null = null;
    let chain = Promise.resolve();
    const mux: any = {
        on: (_p: number, cb: (b: Uint8Array) => void) => { deliver = cb; },
        off: () => { deliver = null; },
        send: (bytes: Uint8Array) => { chain = chain.then(async () => { for (const f of r.receive(bytes)) deliver?.(f); }); },
    };
    const client = new TxSubmitClient(mux);
    return { client, responder: r, settle: async () => { for (let i = 0; i < 10; i++) { await chain; await new Promise((x) => setTimeout(x, 0)); } } };
}

describe("tx-submission client", () => {
    test("txIdOf is the blake2b-256 of the body bytes", () => {
        const a = sampleTx(3);
        expect(toHex(txIdOf(a.bytes))).toBe(a.id);
        expect(() => txIdOf(Cbor.encode(new CborArray([new CborUInt(1)])).toBuffer())).toThrow();
    });

    test("the relay's blocking request waits; a submitted tx is announced, fetched, accepted and acknowledged", async () => {
        const { client, responder, settle } = pair();
        await settle();
        expect(responder.mempool.size).toBe(0);
        const a = sampleTx(1), b = sampleTx(2);
        expect(client.submit(a.bytes)).toBe(a.id);
        await settle();
        expect([...responder.mempool.keys()]).toEqual([a.id]);
        expect(client.list()).toEqual([]);
        client.submit(b.bytes);
        await settle();
        expect(responder.mempool.has(b.id)).toBe(true);
        expect(responder.stats).toEqual({ announced: 2, fetched: 2, accepted: 2, rejected: 0 });
    });
});
