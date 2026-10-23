import { describe, expect, test } from "bun:test";
import { checkTxAnswer, txHashOfPath } from "../src/node/txProofCheck";

const H = "bbe0d151bdfcf3ba4f6008ddfaed9030fae26861dedb108c258c335803727640";
const proof = { certificateHash: "c".repeat(64), latestBlockNumber: 4_785_239, certified: new Map([[H, { start: 4_785_195, end: 4_785_210 }]]) };

describe("phase 5: relayed transaction answers against Mithril", () => {
    test("paths about one transaction", () => {
        expect(txHashOfPath(`/txs/${H}`)).toBe(H);
        expect(txHashOfPath(`/txs/${H.toUpperCase()}/utxos`)).toBe(H);
        expect(txHashOfPath("/blocks/latest")).toBeNull();
        expect(txHashOfPath(`/txs/${H}/x/y`)).toBeNull();
    });

    test("the right block is certified; a wrong block height is a mismatch", () => {
        expect(checkTxAnswer(H, { block_height: 4_785_200 }, proof).status).toBe("certified");
        expect(checkTxAnswer(H, {}, proof).status).toBe("certified"); // e.g. /utxos: the transaction exists
        const lie = checkTxAnswer(H, { block_height: 4_785_300 }, proof);
        expect(lie.status).toBe("mismatch");
        expect(lie.detail).toContain("4785195 to 4785209");
    });

    test("unknown to Mithril: too new, or a made-up transaction", () => {
        const other = "a".repeat(64);
        expect(checkTxAnswer(other, { block_height: 4_785_400 }, proof).status).toBe("too-new");
        expect(checkTxAnswer(other, { block_height: 4_000_000 }, proof).status).toBe("mismatch");
        expect(checkTxAnswer(other, null, null, "HTTP 503")).toEqual({ status: "unavailable", detail: "Mithril: HTTP 503" });
    });
});
