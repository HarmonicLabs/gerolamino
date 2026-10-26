/**
 * Build the unpacked extension into dist/ with Bun's bundler (ESM, browser target):
 *   background.js (service worker), offscreen.js (the node), popup.js, opfsWorker.js, and mithril.js when
 *   src/mithril/ provides an entry; manifest.json, the HTML pages, the stylesheet and generated icons are copied.
 *
 *   bun scripts/build.ts [--minify] [--outdir dist]
 *
 * Fails if a bundle pulls in a Node built-in or a non-HarmonicLabs package (runtime dependencies must be
 * @harmoniclabs/* only).
 */
import { existsSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const outdir = resolve(root, argv.includes("--outdir") ? argv[argv.indexOf("--outdir") + 1]! : "dist");
const minify = argv.includes("--minify");
const ext = join(root, "src/extension");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const entries: Record<string, string> = {
    background: join(ext, "background.ts"),
    offscreen: join(ext, "offscreen.ts"),
    popup: join(ext, "popup.ts"),
    opfsWorker: join(root, "src/node/opfsWorker.ts"),
    approve: join(ext, "approve.ts"),
    // content scripts are classic scripts: bundled as IIFE below
    inpage: join(ext, "inpage.ts"),
    bridge: join(ext, "bridge.ts"),
};
const CLASSIC = new Set(["inpage", "bridge"]);
const mithrilEntry = ["src/mithril/index.ts", "src/mithril/mithrilAnchor.ts"].map((p) => join(root, p)).find((p) => existsSync(p));
if (mithrilEntry) entries.mithril = mithrilEntry;

/** Only @harmoniclabs/* and our own sources may end up in a bundle. */
const allowed = (path: string) => !path.includes("node_modules/") || /node_modules\/@harmoniclabs\//.test(path);
const problems: string[] = [];
let totalBytes = 0;

for (const [name, entry] of Object.entries(entries)) {
    const r = await Bun.build({
        entrypoints: [entry],
        outdir,
        naming: `${name}.js`,
        target: "browser",
        format: CLASSIC.has(name) ? "iife" : "esm",
        minify,
        sourcemap: "linked",
        metafile: true,
    } as any);
    if (!r.success) {
        for (const l of r.logs) console.error(l);
        throw new Error(`build of ${name} failed`);
    }
    const inputs = Object.keys((r as any).metafile?.inputs ?? {});
    for (const i of inputs) if (!allowed(i)) problems.push(`${name}: bundles ${i}`);
    for (const o of r.outputs) if (o.path.endsWith(".js")) {
        const size = o.size ?? (await Bun.file(o.path).size);
        totalBytes += size;
        const text = await Bun.file(o.path).text();
        if (/\brequire\(["'](?:node:)?(?:fs|path|net|crypto|buffer|stream|os|zlib)["']\)/.test(text)) problems.push(`${name}: references a Node built-in`);
        console.log(`  ${name}.js  ${(size / 1024).toFixed(0)} KiB  (${inputs.length} inputs)`);
    }
    for (const l of r.logs) if (l.level === "warning") console.warn(`  ${name}: ${l.message}`);
}
if (problems.length) { console.error(problems.join("\n")); throw new Error("disallowed runtime dependency in the bundle"); }

for (const f of ["manifest.json", "popup.html", "popup.css", "offscreen.html", "approve.html", "logo.svg"]) copyFileSync(join(ext, f), join(outdir, f));
const manifest = JSON.parse(readFileSync(join(outdir, "manifest.json"), "utf8"));
manifest.version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version.replace(/-.*$/, "");
writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2));
for (const size of [16, 48, 128]) writeFileSync(join(outdir, `icon${size}.png`), icon(size));

console.log(`dist ready: ${outdir} (${(totalBytes / 1024).toFixed(0)} KiB of JS${mithrilEntry ? ", with Mithril" : ", without Mithril (src/mithril has no entry yet)"})`);

/** A small PNG icon in the desktop app's colours (a dark disc with a red-to-orange ring), encoded here so the repo carries no binary assets. */
function icon(size: number): Uint8Array {
    const raw = new Uint8Array(size * (size * 4 + 1));
    const c = (size - 1) / 2, r = size / 2;
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x - c, y - c) / r;
            const o = y * (size * 4 + 1) + 1 + x * 4;
            const inside = d <= 1;
            const ring = d > 0.5 && d < 0.8;
            const t = Math.min(1, Math.max(0, (x + y) / (2 * (size - 1)))); // gradient along the diagonal: #FF2D55 → #FF8A00
            raw[o] = ring ? 0xff : 0x0f; raw[o + 1] = ring ? Math.round(0x2d + t * (0x8a - 0x2d)) : 0x14; raw[o + 2] = ring ? Math.round(0x55 - t * 0x55) : 0x18;
            raw[o + 3] = inside ? 255 : Math.max(0, Math.round(255 * (1 - (d - 1) * r)));
        }
    }
    const chunk = (type: string, data: Uint8Array) => {
        const out = new Uint8Array(12 + data.length);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, data.length);
        out.set(new TextEncoder().encode(type), 4);
        out.set(data, 8);
        dv.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0);
        return out;
    };
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, size); dv.setUint32(4, size); ihdr[8] = 8; ihdr[9] = 6;
    const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
    const png = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let off = 0; for (const p of parts) { png.set(p, off); off += p.length; }
    return png;
}
