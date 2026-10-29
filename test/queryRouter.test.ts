import { describe, expect, test } from "bun:test";
import { isBlockfrostCapable, QueryRouter, type QueryCandidate } from "../src/node/queryRouter";

const ok = (url: string): QueryCandidate => ({ url, limits: { rate: 60, windowMs: 10_000, maxBody: 65536 }, query: async () => ({ status: 200, body: JSON.stringify({ from: url }) }) });
const fail = (url: string, status = 502): QueryCandidate => ({ url, limits: { rate: 60, windowMs: 10_000, maxBody: 65536 }, query: async () => ({ status, body: JSON.stringify({ from: url }) }) });
const throwIt = (url: string, message = "light query timed out"): QueryCandidate => ({ url, limits: { rate: 60, windowMs: 10_000, maxBody: 65536 }, query: async () => { throw new Error(message); } });
const v0 = (url: string): QueryCandidate => ({ url, limits: null, query: async () => ({ status: 200, body: JSON.stringify({ from: url }) }) });

describe("peer query router", () => {
    test("the main relay answers first; a 5xx falls over to the next peer", async () => {
        const main = fail("ws://main");
        const extra = ok("ws://extra");
        const router = new QueryRouter(() => [main, extra]);
        const a = await router.query("/addresses/addr/utxos");
        expect(a).toEqual({ status: 200, body: JSON.stringify({ from: "ws://extra" }), peer: "ws://extra" });
        expect(router.failures()).toEqual([]);
    });

    test("a timeout or unsupported peer yields to the next; the 200 names the peer that answered", async () => {
        const router = new QueryRouter(() => [throwIt("ws://main"), ok("ws://extra")]);
        const a = await router.query("/blocks/1000");
        expect(a.peer).toBe("ws://extra");
        expect(a.status).toBe(200);
    });

    test("a peer that announces blockfrost is preferred when the runner lists it first", async () => {
        const router = new QueryRouter(() => [ok("ws://announced"), v0("ws://old")]);
        const a = await router.query("/epochs/latest");
        expect(a.peer).toBe("ws://announced");
    });

    test("announced rate limits skip a peer inside its window without failing the query", async () => {
        let now = 1000;
        const calls: string[] = [];
        const limited: QueryCandidate = { url: "ws://limited", limits: { rate: 2, windowMs: 1000, maxBody: 1024 },
            query: async () => (calls.push("limited"), { status: 200, body: "{}" }) };
        const backup: QueryCandidate = { url: "ws://backup", limits: { rate: 100, windowMs: 1000, maxBody: 1024 },
            query: async () => (calls.push("backup"), { status: 200, body: "{}" }) };
        const router = new QueryRouter(() => [limited, backup], { now: () => now });
        expect((await router.query("/a")).peer).toBe("ws://limited");
        expect((await router.query("/b")).peer).toBe("ws://limited");
        expect((await router.query("/c")).peer).toBe("ws://backup"); // limited's 2/window exhausted
        now += 1001;
        expect((await router.query("/d")).peer).toBe("ws://limited");
    });

    test("all candidates failing gives a 503 in Blockfrost's error shape; no candidate gives 503 too", async () => {
        const router = new QueryRouter(() => [throwIt("ws://main")]);
        const a = await router.query("/pools");
        expect(a.status).toBe(503);
        expect(JSON.parse(a.body)).toMatchObject({ status_code: 503, error: "Service Unavailable" });
        expect(a.body).toMatch(/ws:\/\/main/);
        const empty = new QueryRouter(() => []);
        expect((await empty.query("/x")).peer).toBe("");
        expect(JSON.parse((await empty.query("/x")).body).message).toMatch(/no Gerolamo peer/);
    });

    test("capability gate: an announcement without blockfrost is not capable; version-0 is worth probing", () => {
        expect(isBlockfrostCapable(null)).toBe(true);
        expect(isBlockfrostCapable({ blockfrost: null })).toBe(false);
        expect(isBlockfrostCapable({ blockfrost: { rate: 10, windowMs: 1000, maxBody: 1024 } })).toBe(true);
    });
});
