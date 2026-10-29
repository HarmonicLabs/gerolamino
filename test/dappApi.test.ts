import { describe, expect, test } from "bun:test";
import { APIError, DAPP_RATE, DappApprovals, DappHub, TxSendError, validOrigin } from "../src/extension/dappApi";

function area() {
    const data: Record<string, unknown> = {};
    return { data, get: async (k: string) => ({ [k]: data[k] }), set: async (items: Record<string, unknown>) => { Object.assign(data, items); } };
}
function hub(opts: { allow?: boolean; network?: string; status?: any; query?: (p: string) => Promise<any> } = {}) {
    const asked: string[] = [], queries: string[] = [], txs: string[] = [];
    let t = 1_000_000;
    const approvals = new DappApprovals(area());
    const h = new DappHub({
        approvals,
        askUser: async (o) => { asked.push(o); return opts.allow ?? true; },
        status: () => opts.status ?? { lastSlot: 126_000_000, lastBlockNo: 4_786_000, lastHash: "ab".repeat(32), network: "preview", state: "at-tip", cryptoOk: 10, startMode: "tip", lightQuery: true },
        network: async () => opts.network ?? "preview",
        query: opts.query ?? (async (p) => { queries.push(p); return { status: 200, body: { path: p }, source: "relay", peer: "ws://peer" }; }),
        submitTx: async (c) => { txs.push(c); if (c === "84ff") throw new Error("rejected by the relay"); return "f".repeat(64); },
        now: () => t,
    });
    return { h, asked, queries, txs, approvals, tick: (ms: number) => { t += ms; } };
}
const SITE = "https://dapp.example";

describe("dApp API (window.cardano.gerolamino)", () => {
    test("nothing but isEnabled and enable before the user allows the site", async () => {
        const { h } = hub();
        expect(await h.handle(SITE, "isEnabled", [])).toEqual({ ok: true, result: false });
        expect(await h.handle(SITE, "query", ["/blocks/latest"])).toMatchObject({ ok: false, error: { code: APIError.Refused } });
    });

    test("enable asks the user once; the answer is remembered per site", async () => {
        const { h, asked } = hub();
        expect(await h.handle(SITE, "enable", [])).toEqual({ ok: true, result: true });
        expect(await h.handle(SITE, "enable", [])).toEqual({ ok: true, result: true });
        expect(asked).toEqual([SITE]);
        expect(await h.handle(SITE, "isEnabled", [])).toEqual({ ok: true, result: true });
        expect(await h.handle("https://other.example", "isEnabled", [])).toEqual({ ok: true, result: false });
    });

    test("a denied site is refused; concurrent enable() calls share one approval window", async () => {
        const denied = hub({ allow: false });
        expect(await denied.h.handle(SITE, "enable", [])).toMatchObject({ ok: false, error: { code: APIError.Refused } });
        const { h, asked } = hub();
        await Promise.all([h.handle(SITE, "enable", []), h.handle(SITE, "enable", []), h.handle(SITE, "enable", [])]);
        expect(asked).toHaveLength(1);
    });

    test("a local UTxO ledger answer carries its coverage through the dApp envelope", async () => {
        const ledger = { startSlot: 126_619_215, kind: "verified-start", tipSlot: 126_620_246 };
        const { h } = hub({ query: async () => ({ status: 200, body: [{ tx_hash: "ab".repeat(32), spent_boolean: false }], source: "local", proof: null, ledger }) });
        await h.handle(SITE, "enable", []);
        const r = await h.handle(SITE, "query", ["/txs/" + "ab".repeat(32) + "/utxos"]);
        expect(r).toMatchObject({ ok: true, result: { source: "local", ledger } });
    });

    test("queries and shorthands go to the node with Blockfrost paths; bad paths are invalid requests", async () => {
        const { h, queries } = hub();
        await h.handle(SITE, "enable", []);
        expect(await h.handle(SITE, "query", ["/blocks/latest"])).toEqual({ ok: true, result: { status: 200, body: { path: "/blocks/latest" }, source: "relay", peer: "ws://peer", proof: null, ledger: null } });
        await h.handle(SITE, "getUtxos", ["addr_test1qz"]);
        await h.handle(SITE, "getProtocolParameters", []);
        await h.handle(SITE, "getAccount", ["stake_test1uq"]);
        expect(queries).toEqual(["/blocks/latest", "/addresses/addr_test1qz/utxos", "/epochs/latest/parameters", "/accounts/stake_test1uq"]);
        for (const bad of ["blocks/latest", "/a/../b", 42]) expect(await h.handle(SITE, "query", [bad])).toMatchObject({ ok: false, error: { code: APIError.InvalidRequest } });
        expect(await h.handle(SITE, "getUtxos", ["x/../y"])).toMatchObject({ ok: false, error: { code: APIError.InvalidRequest } });
    });

    test("network id, tip and trust come from the node", async () => {
        const { h } = hub({ network: "mainnet" });
        await h.handle(SITE, "enable", []);
        expect(await h.handle(SITE, "getNetworkId", [])).toEqual({ ok: true, result: 1 });
        expect(await h.handle(SITE, "getTip", [])).toMatchObject({ ok: true, result: { slot: 126_000_000, height: 4_786_000, network: "preview", state: "at-tip" } });
        const trust: any = await h.handle(SITE, "getTrust", []);
        expect(trust.ok).toBe(true);
        expect(trust.result.rows.map((r: any) => r.key)).toContain("blocks");
    });

    test("submitTx takes hex CBOR; a relay failure is TxSendError.Failure", async () => {
        const { h, txs } = hub();
        await h.handle(SITE, "enable", []);
        expect(await h.handle(SITE, "submitTx", ["84a0"])).toEqual({ ok: true, result: "f".repeat(64) });
        expect(await h.handle(SITE, "submitTx", ["84ff"])).toMatchObject({ ok: false, error: { code: TxSendError.Failure } });
        expect(await h.handle(SITE, "submitTx", ["zz"])).toMatchObject({ ok: false, error: { code: APIError.InvalidRequest } });
        expect(txs).toEqual(["84a0", "84ff"]);
    });

    test("rate limit per site; unknown methods and origins are refused", async () => {
        const { h, tick } = hub();
        await h.handle(SITE, "enable", []);
        let refused = 0;
        for (let i = 0; i < DAPP_RATE + 5; i++) if (!(await h.handle(SITE, "getNetworkId", [])).ok) refused++;
        expect(refused).toBe(6);
        tick(10_001);
        expect((await h.handle(SITE, "getNetworkId", [])).ok).toBe(true);
        expect(await h.handle(SITE, "signTx", [])).toMatchObject({ ok: false, error: { code: APIError.InvalidRequest } });
        expect(await h.handle(null, "enable", [])).toMatchObject({ ok: false, error: { code: APIError.Refused } });
        expect(validOrigin("chrome-extension://abc")).toBe(false);
    });

    test("a revoked site has to ask again", async () => {
        const { h, asked, approvals } = hub();
        await h.handle(SITE, "enable", []);
        await approvals.revoke(SITE);
        expect(await h.handle(SITE, "query", ["/blocks/latest"])).toMatchObject({ ok: false, error: { code: APIError.Refused } });
        await h.handle(SITE, "enable", []);
        expect(asked).toEqual([SITE, SITE]);
    });
});
