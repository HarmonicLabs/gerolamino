import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { encodeData, fromLibData } from "../src/node/plutus/data";
import { PARAM_NAMES_V1, PARAM_NAMES_V2, PARAM_NAMES_V3 } from "../src/node/plutus/paramNames";
import { namedParams } from "../src/node/plutus/costs";
import { phase2OfTx, verdictOf, type Phase2Input } from "../src/node/phase2Context";
import { unitsOf } from "../src/node/rules/value";
import type { ResolvedUtxo } from "../src/node/rules/resolvedUtxo";

const DIR = new URL("./fixtures/", import.meta.url);
const PREVIEW_SHELLEY_START_UNIX = 1666656000;
const slotToPosixMs = (slot: bigint): bigint => BigInt(PREVIEW_SHELLEY_START_UNIX + Number(slot)) * 1000n;

/** A preview chain fixture's transaction bytes and resolved inputs, as phase-2 needs them. */
function loadJob(name: string): {
    job: any;
    body: Uint8Array;
    witness: Uint8Array;
    resolved: Map<string, ResolvedUtxo>;
    era: number;
    pv: number;
    params: { cost_models: Record<string, Array<number | bigint | string>>; pv: number };
    input: Phase2Input;
} {
    const job: any = JSON.parse(readFileSync(new URL(name, DIR), "utf8"));
    const resolved = new Map<string, ResolvedUtxo>();
    for (const [ref, hex] of job.resolved as Array<[string, string]>) {
        const o = TxOut.fromCbor(fromHex(hex));
        const datum = (o as any).datum;
        const datumBytes = datum && typeof datum.toBuffer === "function" ? datum.toBuffer() : null;
        const inline = datum && datumBytes == null ? (() => { try { return toHex(encodeData(fromLibData(datum))); } catch { return null; } })() : null;
        const rs = (o as any).refScript;
        resolved.set(ref, {
            ref,
            address: o.address?.toString?.() ?? "",
            value: unitsOf(o.value),
            referenceScriptHash: rs ? toHex(rs.hash.toBytes()) : null,
            hasDatum: !!datum,
            datumHash: datumBytes && datumBytes.length === 32 ? toHex(datumBytes) : null,
            inlineDatumCbor: inline,
            referenceScriptCbor: rs ? toHex(rs.toCborBytes()) : null,
        });
    }
    const pv = Number(job.params.protocol_major_ver);
    const params = { cost_models: job.params.cost_models, pv };
    const body = fromHex(job.bodyHex), witness = fromHex(job.witnessHex);
    const input: Phase2Input = { era: job.era, pv, bodyBytes: body, witnessSetBytes: witness, resolved, slotToPosixMs };
    return { job, body, witness, resolved, era: job.era, pv, params, input };
}

describe("P3 phase-2 on real preview transactions (budgets match the ledger's CEK)", () => {
    // [fixture, redeemer, cpu, mem]; each figure is the ledger's spent units from Gerolamo's fixture suite
    const cases: Array<[string, string, bigint | null, bigint | null]> = [
        ["plutus-preview-64834939-0.json", "0:0 V3 (secp256k1 ECDSA, integerToByteString)", 279652490n, 632245n],
        ["plutus-preview-95107576-0.json", "1:0 V2 (three Ed25519 oracle signatures)", 284206491n, 307346n],
        ["plutus-preview-95071833-2.json", "1:0 V3 (blake2b_224 of serialiseData)", 115254906n, 341202n],
        ["plutus-preview-804660-0.json", "1:0 V2 (Babbage, 10^9 declared)", 386488181n, 1372760n],
        ["plutus-preview-61828322-0.json", "0:1 V3 (BLS12-381 G1 compress/uncompress, 9.1·10^9 cpu)", 9133733892n, 4952050n],
        ["plutus-preview-117653313-0.json", "0:1 V3 protocol 11 (`case` on builtin constants)", 204130933n, 568774n],
        ["plutus-preview-119711898-0.json", "V3 protocol 11 (dropList, batch 6; declared units)", null, null],
        ["plutus-preview-124008114-0.json", "0:0 V2 protocol 11 (semantics variant D; exactly the declared units)", 468052646n, 1534186n],
        ["plutus-preview-120070481-4.json", "3:1 V3 protocol 11 (bls12_381_G1_multiScalarMul of 77 points, batch 6)", 7930226502n, 1384862n],
    ];
    for (const [file, what, cpu, mem] of cases) {
        test(`${file}: ${what}`, () => {
            const { input, params } = loadJob(file);
            const r = phase2OfTx(input.era, input.pv, input.bodyBytes, input.witnessSetBytes, input.resolved, input.slotToPosixMs, { params });
            expect(r.ok).toBe(true);
            expect(verdictOf(input, r)).toEqual({ kind: "ok" });
            if (cpu != null && mem != null) expect(r.outcomes.some((o) => o.budget?.steps === cpu && o.budget?.mem === mem)).toBe(true);
            for (const o of r.outcomes) expect(o.budget!.steps <= o.declared!.cpu && o.budget!.mem <= o.declared!.mem).toBe(true);
            for (const o of r.outcomes.filter((o) => o.language === 3)) expect(o.unit).toBe(true);
        });
    }

    test("the verdict must equal is_valid: the same scripts flagged invalid are a tag mismatch", () => {
        const { input, params } = loadJob("plutus-preview-64834939-0.json");
        const r = phase2OfTx(input.era, input.pv, input.bodyBytes, input.witnessSetBytes, input.resolved, input.slotToPosixMs, { params, markedInvalid: true });
        expect(r.ok).toBe(true);
        expect(verdictOf({ ...input, markedInvalid: true }, r)).toEqual({ kind: "tag-mismatch", detail: "is_valid = false but every script succeeded" });
    });

    test("a script over its declared units fails (ValidationTagMismatch)", () => {
        const { job, input, params } = loadJob("plutus-preview-804660-0.json");
        const declared = "1b00000002540be400"; // 10^10 as a CBOR uint64
        const at = job.witnessHex.indexOf(declared);
        expect(at).toBeGreaterThan(0);
        const patched = job.witnessHex.slice(0, at) + "1a0bebc200" + job.witnessHex.slice(at + declared.length); // 2·10^8
        const r = phase2OfTx(input.era, input.pv, input.bodyBytes, fromHex(patched), input.resolved, input.slotToPosixMs, { params });
        expect(r.ok).toBe(false);
        expect(r.outcomes.some((o) => o.error?.includes("budget exceeded"))).toBe(true);
        expect(verdictOf(input, r).kind).toBe("tag-mismatch");
    });

    test("a Plutus V3 script must return unit, never another term", () => {
        const { input, params } = loadJob("plutus-preview-95071833-2.json");
        const r = phase2OfTx(input.era, input.pv, input.bodyBytes, input.witnessSetBytes, input.resolved, input.slotToPosixMs, { params });
        expect(r.outcomes[0]!.unit).toBe(true);
    });
});

describe("cost models are named per language exactly as the ledger does", () => {
    test("V1 and V2 list their appended parameters in their own orders", () => {
        expect(PARAM_NAMES_V1.slice(166, 170)).toEqual(["serialiseData-cpu-arguments-intercept", "serialiseData-cpu-arguments-slope", "serialiseData-memory-arguments-intercept", "serialiseData-memory-arguments-slope"]);
        expect(PARAM_NAMES_V2.indexOf("serialiseData-cpu-arguments-intercept")).toBe(133);
        expect(PARAM_NAMES_V2.indexOf("integerToByteString-cpu-arguments-c0")).toBe(175);
        expect(PARAM_NAMES_V1.indexOf("integerToByteString-cpu-arguments-c0")).toBe(223);
        expect(PARAM_NAMES_V3.length).toBeGreaterThanOrEqual(350);
    });
    test("a short list leaves the missing parameters at maxBound", () => {
        const short = namedParams(2, new Array(175).fill(7));
        expect(short.get("serialiseData-cpu-arguments-intercept")).toBe(7n);
        expect(short.get("integerToByteString-cpu-arguments-c0")).toBe(9223372036854775807n);
    });
});
