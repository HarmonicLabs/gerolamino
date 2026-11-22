import { DijkstraTx, DijkstraTxBody } from "/media/bakon/data/Dev/HarmonicLabs/cardano-ledger-ts/dist/index.js";
import { readFileSync } from "node:fs";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
const DIR = "/media/bakon/data/Dev/HarmonicLabs/gerolamo/src/consensus/__fixtures__/dijkstra";
const bytes = fromHex(readFileSync(`${DIR}/cardano_ledger_golden_tx.hex`, "utf8").trim());
const tx: any = DijkstraTx.fromCbor(bytes);
const body: any = tx.body;
const counts = (v: any) => Array.isArray(v) ? v.length : v == null ? null : typeof v;
console.log("tx", { inputs: counts(body.inputs), outputs: counts(body.outputs), refInputs: counts(body.refInputs), collateralInputs: counts(body.collateralInputs), certs: counts(body.certs), withdrawals: counts(body.withdrawals), subTransactions: counts(body.subTransactions), directDeposits: counts(body.directDeposits), accountBalanceIntervals: counts(body.accountBalanceIntervals), startingAccountBalanceIntervals: counts(body.startingAccountBalanceIntervals), guards: counts(body.guards), requiredTopLevelGuards: counts(body.requiredTopLevelGuards), witnessesKeys: tx.witnesses ? Object.keys(tx.witnesses) : null });
for (const [i, st] of (body.subTransactions ?? []).entries()) {
    const sb = st?.body ?? st;
    console.log("sub", i, { keys: Object.keys(sb ?? {}), inputs: counts(sb.inputs), outputs: counts(sb.outputs), refInputs: counts(sb.refInputs), collateralInputs: counts(sb.collateralInputs), certs: counts(sb.certs), withdrawals: counts(sb.withdrawals), directDeposits: counts(sb.directDeposits) });
}
console.log("guards sample", body.guards?.slice(0, 2), "required", body.requiredTopLevelGuards?.slice(0, 2));
