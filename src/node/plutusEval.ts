/**
 * P3 phase-2 script execution core: decode a flat UPLC program, apply the transaction arguments
 * (datum, redeemer, script context) and run the ledger's CEK machine with the epoch's cost model.
 * This is the browser's on-chain script path; the full phase-2 context is supplied by the caller.
 * A script failure is a verdict, never a whole-chain failure here.
 */
import { Cbor, CborBytes } from "@harmoniclabs/cbor";
import { defaultV1Costs, defaultV2Costs, defaultV3Costs } from "@harmoniclabs/cardano-costmodels-ts";
import { PARAM_NAMES_V1, PARAM_NAMES_V2, PARAM_NAMES_V3 } from "./plutus/paramNames";
import { costTable } from "./plutus/costs";
import { applyData, decodeProgram } from "./plutus/flat";
import { evaluate as cekEvaluate } from "./plutus/cek";
import { T, VCon } from "./plutus/values";

export interface PlutusVerdict {
    ok: boolean;
    error?: string;
    logs?: string[];
    budget?: { mem: bigint; steps: bigint };
    /** The script's result is the unit constant (Plutus V3 scripts must return unit; V1/V2 may return any term). */
    unit?: boolean;
}

export interface PlutusEvalOpts {
    format?: "flat" | "cbor";
    lang?: 1 | 2 | 3;
    pv?: number;
    /** The epoch's cost-model list for the language (ParamName order); defaults when absent. */
    costValues?: ReadonlyArray<number | bigint | string>;
    /** Declared execution units: the evaluation stops at this budget. */
    declared?: { mem: bigint; cpu: bigint };
    logs?: boolean;
}

const INT64_MAX = 9223372036854775807n;

function defaultValues(lang: 1 | 2 | 3): Array<number | bigint> {
    const names = lang === 1 ? PARAM_NAMES_V1 : lang === 2 ? PARAM_NAMES_V2 : PARAM_NAMES_V3;
    const model = lang === 1 ? defaultV1Costs : lang === 2 ? defaultV2Costs : defaultV3Costs;
    return names.map((n) => (model as any)[n] ?? INT64_MAX);
}

/**
 * Build the ledger's cost model for one language from the epoch's `cost_models` list
 * (the same names and order the ledger uses). Exported for callers that want the raw model.
 */
export function buildCostModel(lang: 1 | 2 | 3, values: ReadonlyArray<number | bigint | string>, pv = 9): any {
    return { lang, values, pv };
}

function unwrapFlat(bytes: Uint8Array): Uint8Array {
    const n = Cbor.parse(bytes);
    if (n instanceof CborBytes) return n.bytes;
    return bytes;
}

/** Run `scriptBytes` (flat by default) against `args` (the ledger's own Data values). */
export function evaluatePlutusScript(scriptBytes: Uint8Array, args: readonly any[] = [], opts: PlutusEvalOpts = {}): PlutusVerdict {
    try {
        if (scriptBytes.length === 0) return { ok: false, error: "empty script" };
        const lang = (opts.lang ?? 3) as 1 | 2 | 3;
        const pv = opts.pv ?? 10;
        const flat = opts.format === "cbor" ? unwrapFlat(scriptBytes) : scriptBytes;
        const prog = decodeProgram(flat, lang, pv);
        const applied = args.length ? applyData(prog, args) : prog;
        const values = opts.costValues && opts.costValues.length ? opts.costValues : defaultValues(lang);
        const costs = costTable(lang, values, pv);
        const declared = opts.declared ?? { cpu: BigInt(Number.MAX_SAFE_INTEGER), mem: BigInt(Number.MAX_SAFE_INTEGER) };
        const budget = { cpu: clampNum(declared.cpu), mem: clampNum(declared.mem) };
        const r = cekEvaluate(applied, costs, budget, { logs: !!opts.logs, pv });
        const unit = r.result instanceof VCon && r.result.type === T.unit;
        return {
            ok: r.ok,
            error: r.error,
            logs: r.logs,
            budget: { mem: BigInt(r.mem), steps: BigInt(r.cpu) },
            unit,
        };
    } catch (e) {
        return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
}

/** Clamp a declared budget to the evaluator's exact Number range. */
function clampNum(v: bigint | number): number {
    const n = typeof v === "bigint" ? Number(v) : v;
    return n > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : n;
}

/** The canonical phase-2 verdict: a script either returns successfully or fails. */
export function phase2Verdict(scriptBytes: Uint8Array, args: readonly any[] = [], format: "flat" | "cbor" = "flat", opts: PlutusEvalOpts = {}): PlutusVerdict {
    return evaluatePlutusScript(scriptBytes, args, { ...opts, format });
}
