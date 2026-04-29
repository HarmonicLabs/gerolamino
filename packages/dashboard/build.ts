/**
 * build.ts — produce a static SPA bundle at `packages/dashboard/dist-spa/`
 * for consumption by `apps/tui`'s Bun.WebView.
 *
 * Pipeline:
 *   1. `@tailwindcss/cli` compiles `src/styles.css` → `dist-spa/styles.css`
 *      (Tailwind v4 utilities + tw-animate-css + uPlot @import resolved).
 *   2. `Bun.build` with `bun-plugin-solid` compiles `src/page.tsx`
 *      → `dist-spa/page.js` (Solid JSX → DOM renderer calls; ESM module).
 *   3. Copy `page.html` to `dist-spa/index.html`.
 *
 * Run: `bun packages/dashboard/build.ts`
 *      (or `NODE_ENV=production bun packages/dashboard/build.ts` for minify)
 *
 * Output is `file://`-loadable directly by Bun.WebView; no dev server needed.
 */
import { SolidPlugin } from "bun-plugin-solid";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dir; // packages/dashboard/
const outDir = resolve(root, "dist-spa");
const isProd = process.env.NODE_ENV === "production";

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log("[dashboard/build] Compiling Tailwind v4 styles...");
const tw = Bun.spawn({
  cmd: [
    "tailwindcss",
    "-i",
    resolve(root, "src/styles.css"),
    "-o",
    resolve(outDir, "styles.css"),
    ...(isProd ? ["--minify"] : []),
  ],
  stdout: "inherit",
  stderr: "inherit",
});
const twExit = await tw.exited;
if (twExit !== 0) {
  console.error("[dashboard/build] Tailwind compile failed");
  process.exit(twExit);
}

console.log("[dashboard/build] Bundling page.tsx with Solid plugin...");
const result = await Bun.build({
  entrypoints: [resolve(root, "src/page.tsx")],
  outdir: outDir,
  target: "browser",
  format: "esm",
  splitting: false,
  minify: isProd,
  sourcemap: isProd ? "none" : "external",
  naming: "page.[ext]",
  plugins: [SolidPlugin({ generate: "dom" })],
});

if (!result.success) {
  console.error("[dashboard/build] Bun.build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log("[dashboard/build] Copying page.html → dist-spa/index.html...");
copyFileSync(resolve(root, "page.html"), resolve(outDir, "index.html"));

console.log(`[dashboard/build] Done. Open file://${outDir}/index.html`);
