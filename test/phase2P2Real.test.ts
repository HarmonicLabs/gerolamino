import { describe, expect, test } from "bun:test";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { TxBody, TxOut } from "@harmoniclabs/cardano-ledger-ts";
import job from "./fixtures/plutus-preview-804660-0.json" with { type: "json" };
import { checkTransactionCore, type LedgerRuleParams } from "../src/node/ledgerRules";
import { outFromTxOut } from "../src/node/ledgerApply";

const params: LedgerRuleParams = { minFeeA: 44, minFeeB: 155381, keyDeposit: 2000000n, poolDeposit: 500000000n, minUTxOValue: 1000000n, maxTxSize: 16384 };

describe("P2 real preview transaction body", () => {
    test("value conservation and fee minimum on a real fixture", () => {
        const body = TxBody.fromCbor(fromHex(job.bodyHex));
        const resolve = (ref: string) => {
            const entry = (job.resolved as Array<[string, string]>).find(([r]) => r === ref);
            if (!entry) return null;
            const o = TxOut.fromCbor(fromHex(entry[1]));
            return outFromTxOut("aa".repeat(32), 0, o, 1);
        };
        const r = checkTransactionCore(body, resolve, params);
        expect(r.inputs).toBeGreaterThan(0);
        expect(r.outputs).toBeGreaterThan(0);
        expect(r.failures.filter((f) => f.startsWith("spent"))).toEqual([]);
        expect(r.failures.some((f) => f.startsWith("value not conserved"))).toBe(false);
    });
});
