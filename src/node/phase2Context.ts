/**
 * P3 phase-2 bridge for the browser: build the ledger script context (TxInfo / ScriptPurpose /
 * ScriptInfo) from the transaction's own bytes and the resolved inputs, then execute each witness
 * script with the flat Plutus evaluator. The full script-context translation lives in
 * `src/node/plutus/context.ts` (ported from Gerolamo); this module is the Gerolamino entry point.
 */
import { Cbor, CborBytes } from "@harmoniclabs/cbor";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { toHex, fromHex } from "@harmoniclabs/uint8array-utils";
import { Script } from "@harmoniclabs/cardano-ledger-ts";
import { TxContext, type ContextInput, type Purpose, type Redeemer } from "./plutus/context";
import { evaluatePlutusScript, type PlutusVerdict } from "./plutusEval";
import { DConstr } from "./plutus/data";
import type { ResolvedUtxo } from "./rules/resolvedUtxo";

export interface Phase2Outcome extends PlutusVerdict {
    scriptHash?: string;
    language?: 1 | 2 | 3 | 4;
    redeemer?: { tag: number; index: number };
    declared?: { mem: bigint; cpu: bigint };
}

/** Raw epoch protocol parameters the script context needs (language cost-model lists + protocol version). */
export interface Phase2Params {
    pv?: number;
    cost_models?: Record<string, ReadonlyArray<number | bigint | string>>;
    raw?: Record<string, any> | null;
}

export interface Phase2Input extends ContextInput {
    /** The transaction's `is_valid` flag; a verdict mismatch means the scripts and it disagree. */
    markedInvalid?: boolean;
    params?: Phase2Params;
}

export type Phase2Verdict = { kind: "ok" } | { kind: "tag-mismatch"; detail: string } | { kind: "no-verdict"; detail: string };

function scriptLanguage(type: string | number): 1 | 2 | 3 | 4 | null {
    const t = String(type);
    return t.includes("V1") ? 1 : t.includes("V2") ? 2 : t.includes("V3") ? 3 : t.includes("V4") ? 4 : null;
}

function findScript(ctx: TxContext, hash: string, resolved: Map<string, ResolvedUtxo>): { lang: 1 | 2 | 3 | 4; bytes: Uint8Array } | undefined {
    const direct = ctx.witnessScripts.get(hash);
    if (direct) return direct;
    for (const s of ctx.witnessScripts.values()) {
        let flat = s.bytes;
        try { const n = Cbor.parse(s.bytes); if (n instanceof CborBytes) flat = n.bytes; } catch { /* raw flat */ }
        if (toHex(blake2b_224(flat)) === hash) return s;
    }
    for (const u of resolved.values()) {
        if (!u.referenceScriptCbor || u.referenceScriptHash !== hash) continue;
        try {
            const script = Script.fromCbor(fromHex(u.referenceScriptCbor));
            const lang = scriptLanguage(script.type);
            if (!lang) continue;
            return { lang, bytes: script.bytes };
        } catch { /* malformed reference script */ }
    }
    return undefined;
}

export function contextOf(input: ContextInput): TxContext { return new TxContext(input); }

/** Script bytes in a witness set are one CBOR bytestring holding the flat program. */
function unwrapFlat(bytes: Uint8Array): Uint8Array {
    try {
        const n = Cbor.parse(bytes);
        if (n instanceof CborBytes) return n.bytes;
    } catch { /* reference scripts carry flat bytes directly */ }
    return bytes;
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

/** Cost-model list for a language from the epoch params (vanilla or script-data keyed). */
function costValuesFor(input: Phase2Input, lang: 1 | 2 | 3): ReadonlyArray<number | bigint | string> | undefined {
    const cm = input.params?.cost_models as Record<string, any> | undefined;
    if (!cm) return undefined;
    const values = cm[`PlutusV${lang}`] ?? cm[`PlutusScriptV${lang}`] ?? cm[String(lang)];
    if (!Array.isArray(values) || values.length === 0) return undefined;
    return values as ReadonlyArray<number | bigint | string>;
}

function failureKind(error: string | undefined): "no-verdict" | "script-failure" {
    return error && (/not found|points to nothing|is not script-locked|no datum|not a CBOR/.test(error)) ? "no-verdict" : "script-failure";
}

export function evaluatePhase2(input: Phase2Input): { ok: boolean; error: string | null; outcomes: Phase2Outcome[] } {
    const ctx = contextOf(input);
    const outcomes: Phase2Outcome[] = [];
    for (const r of ctx.redeemers) {
        const p = ctx.purposeOf(r);
        if (!p) { outcomes.push({ ok: false, error: `redeemer ${r.tag}:${r.index} points to nothing` }); continue; }
        const hash = ctx.scriptHashOf(p);
        if (!hash) { outcomes.push({ ok: false, error: `redeemer ${r.tag}:${r.index} is not script-locked` }); continue; }
        const script = findScript(ctx, hash, input.resolved);
        if (!script || (script.lang !== 1 && script.lang !== 2 && script.lang !== 3)) {
            outcomes.push({ ok: false, error: `script ${hash.slice(0, 12)}… not found` }); continue;
        }
        let args: any[];
        try { args = argumentsFor(ctx, p, r, script.lang as 1 | 2 | 3); } catch (e) {
            outcomes.push({ ok: false, scriptHash: hash, language: script.lang, error: (e as Error).message }); continue;
        }
        const costValues = costValuesFor(input, script.lang as 1 | 2 | 3);
        const declared = { mem: r.mem, cpu: r.cpu };
        const applied = evaluatePlutusScript(unwrapFlat(script.bytes), args, { lang: script.lang as 1 | 2 | 3, pv: input.params?.pv ?? input.pv, costValues, declared });
        const budgetError = applied.ok && applied.budget && (applied.budget.mem > declared.mem || applied.budget.steps > declared.cpu) ? `budget exceeded: spent ${applied.budget.mem}/${applied.budget.steps}, declared ${declared.mem}/${declared.cpu}` : null;
        const unitError = applied.ok && script.lang === 3 && applied.unit === false ? "a Plutus V3 script must return unit" : null;
        outcomes.push({ ...applied, ok: applied.ok && budgetError == null && unitError == null, error: applied.error ?? budgetError ?? unitError ?? undefined, scriptHash: hash, language: script.lang, redeemer: { tag: r.tag, index: r.index }, declared });
    }
    return { ok: outcomes.every((o) => o.ok), error: null, outcomes };
}

/**
 * The phase-2 verdict: every script must succeed inside its declared units, and the verdict must
 * equal the transaction's `is_valid` flag. A context that cannot be built is "no verdict", never a
 * script failure (the caller decides whether it counts).
 */
export function verdictOf(input: Phase2Input, result: { ok: boolean; error: string | null; outcomes: Phase2Outcome[] }): Phase2Verdict {
    const noVerdict = result.error ?? result.outcomes.map((o) => o.error).find((e) => e && failureKind(e) === "no-verdict");
    if (noVerdict) return { kind: "no-verdict", detail: noVerdict };
    const fails = result.outcomes.filter((o) => !o.ok).map((o) => o.error ?? "script failed");
    if (!input.markedInvalid && !result.ok) return { kind: "tag-mismatch", detail: `is_valid = true but ${fails[0] ?? "scripts failed"}` };
    if (input.markedInvalid && result.ok) return { kind: "tag-mismatch", detail: "is_valid = false but every script succeeded" };
    return { kind: "ok" };
}

export function phase2OfTx(era: number, pv: number, bodyBytes: Uint8Array, witnessSetBytes: Uint8Array, resolved: Map<string, ResolvedUtxo>, slotToPosixMs: (slot: bigint) => bigint, opts: { markedInvalid?: boolean; params?: Phase2Params } = {}): { ok: boolean; error: string | null; outcomes: Phase2Outcome[] } {
    return evaluatePhase2({ era, pv, bodyBytes, witnessSetBytes, resolved, slotToPosixMs, ...opts });
}
