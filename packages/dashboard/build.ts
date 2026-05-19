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
import { Console, Effect, FileSystem, Path } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import { BunFileSystem } from "@effect/platform-bun";

const root = import.meta.dir; // packages/dashboard/

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outDir = path.resolve(root, "dist-spa");
  const isProd = process.env["NODE_ENV"] === "production";

  yield* fs.makeDirectory(outDir, { recursive: true });

  yield* Console.log("[dashboard/build] Compiling Tailwind v4 styles...");
  const tw = Bun.spawn({
    cmd: [
      "tailwindcss",
      "-i",
      path.resolve(root, "src/styles.css"),
      "-o",
      path.resolve(outDir, "styles.css"),
      ...(isProd ? ["--minify"] : []),
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  const twExit = yield* Effect.promise(() => tw.exited);
  if (twExit !== 0) {
    yield* Console.error("[dashboard/build] Tailwind compile failed");
    return yield* Effect.fail(new Error(`tailwindcss exited with code ${twExit}`));
  }

  yield* Console.log("[dashboard/build] Bundling page.tsx with Solid plugin...");
  const result = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: [path.resolve(root, "src/page.tsx")],
      outdir: outDir,
      target: "browser",
      format: "esm",
      splitting: false,
      minify: isProd,
      sourcemap: isProd ? "none" : "external",
      naming: "page.[ext]",
      plugins: [SolidPlugin({ generate: "dom" })],
    }),
  );

  if (!result.success) {
    yield* Console.error("[dashboard/build] Bun.build failed:");
    for (const log of result.logs) yield* Console.error(log);
    return yield* Effect.fail(new Error("Bun.build failed"));
  }

  yield* Console.log("[dashboard/build] Copying page.html → dist-spa/index.html...");
  yield* fs.copyFile(path.resolve(root, "page.html"), path.resolve(outDir, "index.html"));

  yield* Console.log(`[dashboard/build] Done. Open file://${outDir}/index.html`);
});

BunRuntime.runMain(program.pipe(Effect.provide(BunFileSystem.layer), Effect.provide(Path.layer)));
