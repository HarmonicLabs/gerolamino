import { describe, expect, test } from "bun:test";
import { DataI } from "@harmoniclabs/plutus-data";
import { checkTransactionCore, unitsOfLovelace } from "../src/node/ledgerRules";
import { evaluatePlutusScript } from "../src/node/plutusEval";

const params = { minFeeA: 44, minFeeB: 155381, keyDeposit: 2000000n, poolDeposit: 500000000n, minUTxOValue: 1000000n };
const out = (ref: string, lovelace: string) => ({ ref, txHash: ref.slice(0, 64), address: "addr_test1", addressBytes: "", lovelace, assets: [], createdSlot: 1, spentSlot: null as number | null });
const txHash = "aa".repeat(32);
const input = (index = 0) => ({ utxoRef: { id: txHash, index } });
const body = { inputs: [input(0)], outputs: [{ value: { lovelaces: 1000000n } }], fee: "155381" };

describe("P2 core ledger rules", () => {
    test("value conservation accepts equal assets and rejects a missing lovelace", () => {
        const resolve = (ref: string) => ref === `${txHash}:0` ? out(ref, "1155381") : null;
        const good = checkTransactionCore(body, resolve, { ...params, maxTxSize: 10000 });
        expect(good.failures.filter((f) => f.startsWith("value"))).toEqual([]);
        expect(good.inputs).toBe(1);
        expect(good.outputs).toBe(1);

        const bad = checkTransactionCore({ ...body, outputs: [out(txHash + ":0", "1000000")] }, resolve, params);
        expect(bad.failures.some((f) => f.startsWith("value not conserved"))).toBe(true);
    });

    test("duplicate inputs, known spent inputs and negative assets fail", () => {
        const resolve = (ref: string) => ref === `${txHash}:0` ? { ...out(ref, "1155381"), spentSlot: 7 } : null;
        const r = checkTransactionCore({ ...body, inputs: [input(0), input(0)] }, resolve, params);
        expect(r.failures).toContain(`duplicate input ${txHash}:0`);
        expect(r.failures.some((f) => f.startsWith(`input ${txHash}:0 already spent`))).toBe(true);
    });

    test("mint and withdrawals are consumed exactly", () => {
        const resolve = () => out(`${txHash}:0`, "1000000");
        const b = { ...body, inputs: [input(0)], mint: [], withdrawals: { map: [{ amount: 1000n }] }, outputs: [], fee: "0" };
        const r = checkTransactionCore(b, resolve, params);
        expect(unitsOfLovelace(1000000n).get("lovelace")).toBe(1000000n);
    });
});

describe("P3 phase-2 script evaluator", () => {
    test("a flat script evaluates; tampered bytes fail parse", () => {
        const bytes = new Uint8Array("010000320014c101070001".match(/../g)!.map((x) => parseInt(x, 16)));
        const r = evaluatePlutusScript(bytes);
        expect(r.ok).toBe(true);
        const bad = bytes.slice();
        bad[4] ^= 0xff;
        expect(evaluatePlutusScript(bad).ok).toBe(false);
    });
});
