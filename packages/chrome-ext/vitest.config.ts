/**
 * Vitest config for chrome-ext Solid UI unit tests (jsdom).
 *
 * Run: `bun run test` from `packages/chrome-ext`, or
 * `bunx --bun vitest run -c packages/chrome-ext/vitest.config.ts` from the repo root.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string, sub = "src") => path.resolve(root, `../${name}/${sub}`);

export default defineConfig({
  plugins: [solid()],
  define: {
    __BOOTSTRAP_URL__: JSON.stringify("ws://localhost:3040"),
  },
  test: {
    name: "chrome-ext",
    environment: "jsdom",
    globals: false,
    setupFiles: [path.resolve(root, "vitest.setup.ts")],
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      dashboard: path.resolve(pkg("dashboard"), "index.ts"),
      "dashboard/delta": path.resolve(pkg("dashboard"), "delta.ts"),
      "dashboard/styles.css": path.resolve(pkg("dashboard"), "styles.css"),
      codecs: path.resolve(pkg("codecs"), "index.ts"),
      ledger: path.resolve(pkg("ledger"), "index.ts"),
      storage: path.resolve(pkg("storage"), "index.ts"),
      bootstrap: path.resolve(pkg("bootstrap"), "index.ts"),
      consensus: path.resolve(pkg("consensus"), "index.ts"),
      miniprotocols: path.resolve(pkg("miniprotocols"), "index.ts"),
      "lsm-ffi": path.resolve(pkg("wasm-utils"), "lsm/index.ts"),
      "wasm-utils": path.resolve(pkg("wasm-utils"), "index.ts"),
      "wasm-plexer": path.resolve(root, "../wasm-plexer/browser.js"),
    },
  },
});
