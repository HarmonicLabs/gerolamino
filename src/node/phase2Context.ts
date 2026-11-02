/**
 * P3 phase-2 bridge for the browser: build the ledger script context (TxInfo / ScriptPurpose /
 * ScriptInfo) from the transaction's own bytes and the resolved inputs, then execute each witness
 * script with the flat Plutus evaluator. The full script-context translation lives in
 * `src/node/plutus/context.ts` (ported from Gerolamo); this module is the Gerolamino entry point.
 */
import { Cbor, CborBytes } from "@harmoniclabs/cbor";
import { TxContext, type ContextInput, type Purpose, type Redeemer } from "./plutus/context";
import { evaluatePlutusScript, type PlutusVerdict } from "./plutusEval";
import { DConstr, encodeData } from "./plutus/data";
import { dataFromCbor } from "@harmoniclabs/plutus-data";
import type { ResolvedUtxo } from "./rules/resolvedUtxo";

export interface Phase2Outcome extends PlutusVerdict {
    scriptHash?: string;
    language?: 1 | 2 | 3 | 4;
    redeemer?: { tag: number; index: number };
    declared?: { mem: bigint; cpu: bigint };
}

export function contextOf(input: ContextInput): TxContext { return new TxContext(input); }

/** Script bytes in a witness set are one CBOR bytestring holding the flat program. */
function unwrapFlat(bytes: Uint8Array): Uint8Array {
    const n = Cbor.parse(bytes);
    if (!(n instanceof CborBytes)) throw new Error("phase2 script is not a CBOR bytestring");
    return n.bytes;
}

function argumentsFor(ctx: TxContext, p: Purpose, r: Redeemer, lang: 1 | 2 | 3): any[] {
    const info = ctx.txInfo(lang);
    if (lang === 3) return [new DConstr(0n, [info, r.data, ctx.scriptInfoData(p)])];
    const sc = new DConstr(0n, [info, ctx.purposeData(p, lang)]);
    const args: any[] = [];
    if (p.tag === 0) {
        const d = ctx.spendingDatum(p);
        if (!d) throw new Error(`no datum for spend redeemer ${r.index}`);
        args.push(d);
    }
    args.push(r.data, sc);
    return args;
}

export function evaluatePhase2(input: ContextInput): { ok: boolean; error: string | null; outcomes: Phase2Outcome[] } {
    const ctx = contextOf(input);
    const outcomes: Phase2Outcome[] = [];
    for (const r of ctx.redeemers) {
        const p = ctx.purposeOf(r);
        if (!p) { outcomes.push({ ok: false, error: `redeemer ${r.tag}:${r.index} points to nothing` }); continue; }
        const hash = ctx.scriptHashOf(p);
        if (!hash) { outcomes.push({ ok: false, error: `redeemer ${r.tag}:${r.index} is not script-locked` }); continue; }
        const script = ctx.witnessScripts.get(hash);
        if (!script || (script.lang !== 1 && script.lang !== 2 && script.lang !== 3)) {
            outcomes.push({ ok: false, error: `script ${hash.slice(0, 12)}… not found` }); continue;
        }
        let args: any[];
        try { args = argumentsFor(ctx, p, r, script.lang as 1 | 2 | 3); } catch (e) {
            outcomes.push({ ok: false, scriptHash: hash, language: script.lang, error: (e as Error).message }); continue;
        }
        const applied = evaluatePlutusScript(unwrapFlat(script.bytes), args.map((a) => dataFromCbor(encodeData(a))));
        outcomes.push({ ...applied, scriptHash: hash, language: script.lang, redeemer: { tag: r.tag, index: r.index }, declared: { mem: r.mem, cpu: r.cpu } });
    }
    return { ok: outcomes.every((o) => o.ok), error: null, outcomes };
}

export function phase2OfTx(era: number, pv: number, bodyBytes: Uint8Array, witnessSetBytes: Uint8Array, resolved: Map<string, ResolvedUtxo>, slotToPosixMs: (slot: bigint) => bigint): { ok: boolean; error: string | null; outcomes: Phase2Outcome[] } {
    return evaluatePhase2({ era, pv, bodyBytes, witnessSetBytes, resolved, slotToPosixMs });
}
