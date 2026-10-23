/**
 * Test helper: the responder (relay) side of tx-submission2, as cardano-node 11 speaks it, as a pure
 * bytes-in / frames-out state machine (modelled on Gerolamo's TxSubmissionResponder). It asks for ids with
 * blocking requests, fetches every announced id it does not hold, checks each body hashes to its id and
 * acknowledges in order.
 */
import { Cbor, CborArray, CborBytes, CborSimple, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { txIdOf } from "../../src/node/txSubmit";

export class TestTxResponder {
    readonly mempool = new Map<string, Uint8Array>();
    readonly stats = { announced: 0, fetched: 0, accepted: 0, rejected: 0 };
    private announced: string[] = [];
    private fetching: string[] = [];
    constructor(private readonly window = 5) {}

    private requestIds(ack: number): Uint8Array {
        return Cbor.encode(new CborArray([new CborUInt(0), new CborSimple(true), new CborUInt(ack), new CborUInt(this.window)])).toBuffer();
    }

    receive(bytes: Uint8Array): Uint8Array[] {
        const out: Uint8Array[] = [];
        let off = 0;
        while (off < bytes.length) {
            const { parsed, offset } = Cbor.parseWithOffset(bytes.subarray(off));
            off += offset;
            const m = parsed as CborArray;
            const tag = Number((m.array[0] as CborUInt).num);
            if (tag === 6) out.push(this.requestIds(0));
            else if (tag === 1) {
                const ids = (m.array[1] as CborArray).array.map((x) => toHex((((x as CborArray).array[0] as CborArray).array[1] as CborBytes).bytes));
                this.stats.announced += ids.length;
                this.announced.push(...ids);
                const want = ids.filter((id) => !this.mempool.has(id));
                if (want.length) {
                    this.fetching = want;
                    out.push(Cbor.encode(new CborArray([new CborUInt(2), new CborArray(want.map((id) => new CborArray([new CborUInt(6), new CborBytes(Uint8Array.from(id.match(/../g)!, (h) => parseInt(h, 16)))])), { indefinite: true })])).toBuffer());
                } else out.push(this.ack());
            } else if (tag === 3) {
                for (const t of (m.array[1] as CborArray).array as CborObj[]) {
                    this.stats.fetched++;
                    const bytes = (((t as CborArray).array[1] as CborTag).data as CborBytes).bytes;
                    const id = toHex(txIdOf(bytes));
                    if (this.fetching.includes(id)) { this.mempool.set(id, bytes); this.stats.accepted++; } else this.stats.rejected++;
                }
                this.fetching = [];
                out.push(this.ack());
            }
        }
        return out;
    }

    private ack(): Uint8Array { const n = this.announced.length; this.announced = []; return this.requestIds(n); }
}
