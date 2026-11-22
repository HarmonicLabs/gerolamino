import { readFileSync } from "node:fs";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { encodeData, fromLibData } from "./src/node/plutus/data";
import { phase2OfTx, verdictOf } from "./src/node/phase2Context";
import { unitsOf } from "./src/node/rules/value";

const DIR = new URL("./test/fixtures/", import.meta.url);
const slotToPosixMs = (slot: bigint): bigint => BigInt(1666656000 + Number(slot)) * 1000n;
function load(name: string) {
    const job: any = JSON.parse(readFileSync(new URL(name, DIR), "utf8"));
    const resolved = new Map<string, any>();
    for (const [ref, hex] of job.resolved) { const o = TxOut.fromCbor(fromHex(hex)); const datum = (o as any).datum;
        const datumBytes = datum && typeof datum.toBuffer === "function" ? datum.toBuffer() : null;
        const inline = datum && datumBytes == null ? (() => { try { return toHex(encodeData(fromLibData(datum))); } catch { return null; } })() : null;
        const rs = (o as any).refScript;
        resolved.set(ref, { ref, address: o.address?.toString?.() ?? "", value: unitsOf(o.value),
            referenceScriptHash: rs ? toHex(rs.hash.toBytes()) : null,
            hasDatum: !!datum, datumHash: datumBytes && datumBytes.length === 32 ? toHex(datumBytes) : null,
            inlineDatumCbor: inline, referenceScriptCbor: rs ? toHex(rs.toCborBytes()) : null });
    }
    const pv = Number(job.params.protocol_major_ver);
    const params = { cost_models: job.params.cost_models, pv };
    const input = { era: job.era, pv, bodyBytes: fromHex(job.bodyHex), witnessSetBytes: fromHex(job.witnessHex), resolved, slotToPosixMs, markedInvalid: !job.valid };
    return { input, params };
}
for (const f of ["plutus-preview-61828322-0.json", "plutus-preview-120070481-4.json"]) {
    const { input, params } = load(f);
    const r: any = phase2OfTx(input.era, input.pv, input.bodyBytes, input.witnessSetBytes, input.resolved, slotToPosixMs, { params });
    console.log(f, { ok: r.ok, error: r.error });
    for (const o of r.outcomes) console.log(JSON.stringify(o, (_k,v) => typeof v === "bigint" ? v.toString() : v));
    console.log("verdict", verdictOf(input, r));
}
