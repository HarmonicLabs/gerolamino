/**
 * Minimal USTAR/pax tar reader for the Mithril `ancillary` archive (`.tar.zst`).
 * The archive is already decompressed by `zstd.ts`; this extracts `ledger/<slot>/tables` and
 * `ledger/<slot>/meta` without a filesystem, so it works in the browser. It handles normal USTAR,
 * GNU longname (`L`) and pax (`x`) headers; symlinks and sparse files are not needed here.
 */
export function extractTarFiles(tar: Uint8Array): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    let off = 0;
    let longName: string | null = null;
    let paxName: string | null = null;
    while (off + 512 <= tar.length) {
        const header = tar.subarray(off, off + 512);
        if (header.every((b) => b === 0)) break;
        const name = readString(header.subarray(0, 100));
        const mode = readOctal(header.subarray(100, 108));
        const size = readOctal(header.subarray(124, 136));
        const mtime = readOctal(header.subarray(136, 148));
        const type = header[156] ?? 0;
        const prefix = readString(header.subarray(345, 345 + 155));
        const path = prefix ? `${prefix.replace(/\/$/, "")}/${name}` : name;
        const body = tar.subarray(off + 512, off + 512 + size);
        const round = (n: number) => Math.ceil(n / 512) * 512;
        if (type === 0x4c) longName = readString(body);
        else if (type === 0x78) paxName = parsePaxPath(body);
        else if (type === 0x30 || type === 0x00 || type === 0) {
            const resolved = paxName ?? longName ?? path;
            if (resolved.startsWith("/")) throw new Error(`tar: absolute path ${resolved}`);
            out.set(resolved, body.slice());
            longName = null; paxName = null;
        }
        off += 512 + round(size);
        void mode; void mtime;
    }
    return out;
}

function readString(bytes: Uint8Array): string {
    let end = bytes.length;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) { end = i; break; }
    return new TextDecoder().decode(bytes.subarray(0, end));
}

function readOctal(bytes: Uint8Array): number {
    let n = 0, any = false;
    for (const b of bytes) {
        if (b === 0 || b === 0x20) { if (any) break; continue; }
        if (b >= 0x30 && b <= 0x37) { any = true; n = n * 8 + (b - 0x30); }
        else if (any) break;
    }
    return n;
}

/** pax extended header: a sequence of `id size value` records; keep the `path` record. */
function parsePaxPath(bytes: Uint8Array): string | null {
    let off = 0;
    while (off < bytes.length) {
        let sp = off;
        while (sp < bytes.length && bytes[sp] !== 0x20) sp++;
        if (sp >= bytes.length) break;
        const len = Number(new TextDecoder().decode(bytes.subarray(off, sp)));
        if (!Number.isFinite(len) || len <= 0 || off + len > bytes.length) break;
        const record = bytes.subarray(sp + 1, off + len - 1);
        const eq = record.indexOf(0x3d);
        if (eq > 0) {
            const key = new TextDecoder().decode(record.subarray(0, eq));
            const value = new TextDecoder().decode(record.subarray(eq + 1));
            if (key === "path") return value;
        }
        off += len;
    }
    return null;
}
