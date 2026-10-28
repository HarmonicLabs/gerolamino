import { describe, expect, test } from "bun:test";
import { enableGerolamino, gerolaminoFetch, gerolaminoProvider, hasGerolamino, type GerolaminoApi } from "../src/dapp/blockfrostProvider";

const fake = () => {
    const calls: string[] = [];
    const api: GerolaminoApi = {
        query: async (path) => {
            calls.push(path);
            if (path === "/blocks/latest") return { status: 200, body: { height: 4803086, slot: 126571120 }, source: "local" };
            if (path.startsWith("/addresses/") && path.includes("page=1")) return { status: 200, body: Array.from({ length: 100 }, (_, i) => ({ tx_hash: `t${i}` })), source: "relay" };
            if (path.startsWith("/addresses/") && path.includes("page=2")) return { status: 200, body: [{ tx_hash: "t100" }], source: "relay" };
            if (path === "/missing") return { status: 404, body: { error: "Not Found" }, source: "relay" };
            return { status: 400, body: { error: "bad" }, source: "local" };
        },
        submitTx: async (hex) => (calls.push(`submit:${hex}`), "aa".repeat(32)),
        getNetworkId: async () => 0,
        getTip: async () => ({ slot: 126571120, height: 4803086, hash: "h", network: "preview", state: "at-tip", peerTip: null }),
    };
    return { api, calls };
};

describe("Gerolamino Blockfrost transport", () => {
    test("detects and enables through window.cardano.gerolamino", async () => {
        const win = { cardano: { gerolamino: { name: "Gerolamino", apiVersion: "1", isWallet: false, enable: async () => fake().api } } };
        expect(hasGerolamino(win)).toBe(true);
        expect(hasGerolamino({})).toBe(false);
        expect(hasGerolamino(undefined)).toBe(false);
        const api = await enableGerolamino(win);
        expect(typeof api.query).toBe("function");
        expect(enableGerolamino({ cardano: {} })).rejects.toThrow(/not installed/);
    });

    test("GET with paging, json decode, error mapping", async () => {
        const { api, calls } = fake();
        const p = gerolaminoProvider(api);
        const a = await p.get("/blocks/latest");
        expect(a).toEqual({ status: 200, body: { height: 4803086, slot: 126571120 }, source: "local" });
        const b = await p.get("/addresses/addr_test1", { count: 100, page: 1, order: "desc" });
        expect(b.status).toBe(200);
        expect(calls.at(-1)).toBe("/addresses/addr_test1?count=100&page=1&order=desc");
        expect(await p.json("/blocks/latest")).toEqual({ height: 4803086, slot: 126571120 });
        expect(p.json("/missing")).rejects.toThrow(/404/);
        expect((await p.get("/other")).status).toBe(400);
    });

    test("getAllPages stops on the short page", async () => {
        const { api, calls } = fake();
        const p = gerolaminoProvider(api);
        const all = await p.getAllPages("/addresses/addr_test1/utxos");
        expect(all.length).toBe(101);
        expect(calls.filter((c) => c.includes("page="))).toEqual([
            "/addresses/addr_test1/utxos?count=100&page=1",
            "/addresses/addr_test1/utxos?count=100&page=2",
        ]);
    });

    test("submitTx forwards the hex and returns the id; fetch-shaped call strips /api/v0", async () => {
        const { api, calls } = fake();
        const p = gerolaminoProvider(api);
        expect(await p.submitTx("deadbeef")).toBe("aa".repeat(32));
        expect(calls.at(-1)).toBe("submit:deadbeef");
        const f = gerolaminoFetch(api);
        const r = await f("http://127.0.0.1:3040/api/v0/blocks/latest");
        expect(r).toEqual({ status: 200, body: { height: 4803086, slot: 126571120 }, source: "local" });
        expect(calls.at(-1)).toBe("/blocks/latest");
    });
});
