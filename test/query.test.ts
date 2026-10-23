import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalChainIndex, indexBlock } from "../src/node/localIndex";
import { answerLocally, answerQuery, normalizePath } from "../src/node/query";
import { networkByName } from "../src/node/networks";

/**
 * Two real preview blocks (from a Gerolamo node's chunk store) with Gerolamo's own Blockfrost answers for them:
 * every field Gerolamino answers locally must equal what the full node says.
 */
const fixtures = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/preview-blocks-blockfrost.json"), "utf8")) as Array<{
    blockHex: string; blockfrost: { block: Record<string, unknown>; txs: string[]; tx0: Record<string, unknown>; tx1: Record<string, unknown> };
}>;
const network = networkByName("preview")!;
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/** The fields the local answer carries must match Blockfrost's exactly (confirmations aside: they are relative to each node's tip). */
function expectSubset(local: Record<string, unknown>, bf: Record<string, unknown>, skip: string[] = []) {
    for (const [k, v] of Object.entries(local)) {
        if (skip.includes(k)) continue;
        expect({ field: k, value: v }).toEqual({ field: k, value: bf[k] });
    }
}

describe("local query answers equal Gerolamo's Blockfrost", () => {
    const index = new LocalChainIndex();
    for (const f of [...fixtures].reverse()) index.add(bytes(f.blockHex)); // oldest first, like the store
    const ctx = { index, network };

    test("blocks: by hash and by height", () => {
        for (const f of fixtures) {
            const bf = f.blockfrost.block;
            const byHash = answerLocally(`/blocks/${bf.hash}`, ctx) as Record<string, unknown>;
            expect(byHash).not.toBeNull();
            expectSubset(byHash, bf, ["confirmations", "next_block"]);
            expect(answerLocally(`/blocks/${bf.height}`, ctx)).toEqual(byHash);
            expect(answerLocally(`/blocks/${bf.hash}/txs`, ctx)).toEqual(f.blockfrost.txs);
        }
    });

    test("transactions: every field the block's bytes determine", () => {
        for (const f of fixtures) for (const bf of [f.blockfrost.tx0, f.blockfrost.tx1]) {
            const local = answerLocally(`/txs/${bf.hash}`, ctx) as Record<string, unknown>;
            expect(local).not.toBeNull();
            expectSubset(local, bf);
        }
    });

    test("latest is the newest stored block; unknown data is not answered locally", () => {
        expect((answerLocally("/blocks/latest", ctx) as any).hash).toBe(fixtures[0]!.blockfrost.block.hash);
        expect(answerLocally("/blocks/1", ctx)).toBeNull();
        expect(answerLocally("/addresses/addr_test1x/utxos", ctx)).toBeNull();
        expect(answerLocally("/epochs/latest", ctx)).toBeNull();
    });

    test("rollback drops the newer block and its transactions", () => {
        const ix = new LocalChainIndex();
        const older = indexBlock(bytes(fixtures[1]!.blockHex)), newer = indexBlock(bytes(fixtures[0]!.blockHex));
        ix.add(bytes(fixtures[1]!.blockHex)); ix.add(bytes(fixtures[0]!.blockHex));
        expect(ix.rollbackTo(older.slot)).toBe(1);
        expect(ix.block(newer.hash)).toBeNull();
        expect(ix.tx(newer.txs[0]!.hash)).toBeNull();
        expect(ix.tip!.hash).toBe(older.hash);
    });
});

describe("answerQuery: local first, then the Gerolamo peer", () => {
    const index = new LocalChainIndex();
    index.add(bytes(fixtures[0]!.blockHex));

    test("a local answer never touches the peer", async () => {
        let asked = 0;
        const a = await answerQuery("/api/v0/blocks/latest", { index, network, relay: async () => { asked++; return { status: 200, body: "{}" }; } });
        expect(a.source).toBe("local");
        expect(asked).toBe(0);
    });

    test("missing data goes to the peer, which answers with JSON", async () => {
        const a = await answerQuery("/addresses/addr_test1x/utxos", {
            index, network, peer: "ws://relay/n2n",
            relay: async (p) => ({ status: 200, body: JSON.stringify([{ asked: p }]) }),
        });
        expect(a).toMatchObject({ source: "relay", status: 200, body: [{ asked: "/addresses/addr_test1x/utxos" }], peer: "ws://relay/n2n" });
    });

    test("no peer that answers queries: 503 from Gerolamino itself", async () => {
        const a = await answerQuery("/pools", { index, network });
        expect(a.source).toBe("none");
        expect(a.status).toBe(503);
    });

    test("paths are normalised the way Blockfrost URLs are written", () => {
        expect(normalizePath("blocks/latest")).toBe("/blocks/latest");
        expect(normalizePath("/api/v0/txs/ab/")).toBe("/txs/ab");
        expect(normalizePath("https://cardano-preview.blockfrost.io/api/v0/epochs/latest?x=1")).toBe("/epochs/latest?x=1");
    });
});

import { Cbor, CborMap, CborSimple, CborText, CborUInt } from "@harmoniclabs/cbor";
import { parseCapabilities } from "../src/node/lightQuery";

describe("light-query hello capabilities", () => {
    test("a version-1 hello's map is read; a version-0 hello has none", () => {
        const t = (s: string) => new CborText(s);
        const caps = parseCapabilities(Cbor.parse(Cbor.encode(new CborMap([
            { k: t("nonce"), v: new CborSimple(true) }, { k: t("stake"), v: new CborSimple(true) }, { k: t("chunk"), v: new CborSimple(false) },
            { k: t("blockfrost"), v: new CborMap([{ k: t("rate"), v: new CborUInt(30) }, { k: t("window_ms"), v: new CborUInt(10_000) }, { k: t("max_body"), v: new CborUInt(524_288) }]) },
        ])).toBuffer()));
        expect(caps).toEqual({ nonce: true, stake: true, chunk: false, blockfrost: { rate: 30, windowMs: 10_000, maxBody: 524_288 } });
        expect(parseCapabilities(undefined)).toBeNull();
        expect(parseCapabilities(Cbor.parse(Cbor.encode(new CborMap([{ k: t("nonce"), v: new CborSimple(true) }])).toBuffer()))!.blockfrost).toBeNull();
    });
});
