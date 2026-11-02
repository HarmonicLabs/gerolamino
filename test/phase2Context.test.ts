import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import job from "./fixtures/plutus-preview-804660-0.json" with { type: "json" };
import { phase2OfTx } from "../src/node/phase2Context";
import { unitsOf } from "../src/node/rules/value";
import type { ResolvedUtxo } from "../src/node/rules/resolvedUtxo";

describe("P3 phase-2 real preview transaction", () => {
    test("builds the script context from the fixture and evaluates the witness script", () => {
        const resolved = new Map<string, ResolvedUtxo>();
        for (const [ref, hex] of job.resolved as Array<[string, string]>) {
            const o = TxOut.fromCbor(fromHex(hex));
            const datum = (o as any).datum;
            const datumBytes = datum && typeof datum.toBuffer === "function" ? datum.toBuffer() : null;
            resolved.set(ref, {
                ref,
                address: o.address?.toString?.() ?? "",
                value: unitsOf(o.value),
                referenceScriptHash: (o as any).refScript?.hash?.toString?.() ?? null,
                hasDatum: !!datum,
                datumHash: datumBytes && datumBytes.length === 32 ? toHex(datumBytes) : null,
                inlineDatumCbor: datum && datum?.toJson && datum?.toCbor ? (() => { try { const c = datum.toCbor(); return toHex(c.toBuffer?.() ?? c); } catch { return null; } })() : null,
                referenceScriptCbor: (o as any).refScript?.toCbor?.() ? toHex((o as any).refScript.toCbor().toBuffer?.() ?? (o as any).refScript.toCbor()) : null,
            });
        }
        const r = phase2OfTx(job.era, Number(job.params.protocol_major_ver), fromHex(job.bodyHex), fromHex(job.witnessHex), resolved, (slot) => BigInt(job.slot ?? 0) * 1000n + BigInt(slot) * 1000n);
        expect(r.outcomes.length).toBeGreaterThan(0);
        expect(r.outcomes[0]!.scriptHash).toMatch(/^[0-9a-f]{56}$/);
        expect(r.outcomes[0]!.ok).toBe(true);
    });
});
