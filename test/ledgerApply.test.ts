import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ledgerDiffFromBlock } from "../src/node/ledgerApply";

const fixture = (name: string) => Uint8Array.from(Buffer.from(readFileSync(`test/fixtures/${name}`, "utf8").trim(), "hex"));

describe("local ledger UTxO projection", () => {
    test("a real preview block yields outputs, spend refs and consistent address/value fields", () => {
        const diff = ledgerDiffFromBlock(fixture("preview-block-12925989.hex"), 12_925_989, "ab".repeat(32));
        expect(diff.txs).toBeGreaterThan(0);
        expect(diff.created.length).toBeGreaterThan(0);
        for (const o of diff.created) {
            expect(o.ref.startsWith(o.txHash + ":")).toBe(true);
            expect(/^[0-9a-f]{64}$/.test(o.txHash)).toBe(true);
            expect(o.address.startsWith("addr")).toBe(true);
            expect(/^\d+$/.test(o.lovelace)).toBe(true);
            for (const a of o.assets) expect(/^[0-9a-f]{56}$/.test(a.policy)).toBe(true);
            expect(o.spentSlot).toBeNull();
        }
        // input refs are txid:index; a block may spend nothing (the first stored block), but never has a bad ref
        for (const ref of diff.spent) expect(/^[0-9a-f]{64}:\d+$/.test(ref)).toBe(true);
    });

    test("the same bytes are deterministic: no hidden state, same digest-relevant fields", () => {
        const a = ledgerDiffFromBlock(fixture("preview-block-10703285.hex"), 10_703_285, "cd".repeat(32));
        const b = ledgerDiffFromBlock(fixture("preview-block-10703285.hex"), 10_703_285, "cd".repeat(32));
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});
