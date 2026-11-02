/**
 * P3 phase-2 script execution core: parse a flat UPLC script, apply the transaction arguments
 * (when supplied) and run the plutus machine with the protocol's cost model. This is the browser's
 * on-chain script path; the full phase-2 context (datum/redeemer/script info) is supplied by the
 * caller. A script failure is a verdict, never a whole-chain failure here.
 */
import { UPLCDecoder, Application, UPLCConst } from "@harmoniclabs/uplc";
import { Machine } from "@harmoniclabs/plutus-machine";
import type { Data } from "@harmoniclabs/plutus-data";

export interface PlutusVerdict {
    ok: boolean;
    error?: string;
    logs?: string[];
    budget?: { mem: bigint; steps: bigint };
}

/** Run `scriptBytes` (flat by default) against `args` encoded as Plutus data values. */
export function evaluatePlutusScript(scriptBytes: Uint8Array, args: Data[] = [], opts: { format?: "flat" | "cbor"; costModel?: any } = {}): PlutusVerdict {
    try {
        if (scriptBytes.length === 0) return { ok: false, error: "empty script" };
        let term = UPLCDecoder.parse(scriptBytes, opts.format ?? "flat").body;
        for (const arg of args) term = new Application(term, UPLCConst.data(arg));
        const machine = opts.costModel ? new (Machine as any)(opts.costModel) : null;
        const r = machine ? (machine as any).eval(term) : (Machine as any).eval(term);
        const mem = r?.budgetSpent?._exBudgetMem?.toString?.() ?? r?.budgetSpent?.mem?.toString?.();
        const steps = r?.budgetSpent?._exBudgetCPU?.toString?.() ?? r?.budgetSpent?.steps?.toString?.();
        return { ok: true, logs: r?.logs ?? [], budget: mem != null && steps != null ? { mem: BigInt(mem), steps: BigInt(steps) } : undefined };
    } catch (e) {
        return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
}

/** The canonical phase-2 verdict: a script either returns successfully or fails. */
export function phase2Verdict(scriptBytes: Uint8Array, args: Data[] = [], format: "flat" | "cbor" = "flat"): PlutusVerdict {
    return evaluatePlutusScript(scriptBytes, args, { format });
}
