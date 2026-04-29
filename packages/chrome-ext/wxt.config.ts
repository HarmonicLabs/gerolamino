import { defineConfig } from "wxt";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const pkg = (name: string, sub: string = "src") => path.join(root, "packages", name, sub);

/**
 * Workspace package aliases for Vite — maps tsconfig.base.json paths
 * so Rolldown can resolve bare specifiers like "consensus/crypto.ts".
 *
 * Each entry supports both:
 *   - Bare import: `import { X } from "consensus"` → index.ts
 *   - Deep import: `import { X } from "consensus/crypto.ts"` → src/crypto.ts
 */
const workspaceAliases = [
  { find: /^codecs$/, replacement: path.join(pkg("codecs"), "index.ts") },
  { find: /^codecs\/(.*)/, replacement: path.join(pkg("codecs"), "$1") },
  { find: /^ledger$/, replacement: path.join(pkg("ledger"), "index.ts") },
  { find: /^ledger\/(.*)/, replacement: path.join(pkg("ledger"), "$1") },
  { find: /^storage$/, replacement: path.join(pkg("storage"), "index.ts") },
  { find: /^storage\/(.*)/, replacement: path.join(pkg("storage"), "$1") },
  { find: /^miniprotocols$/, replacement: path.join(pkg("miniprotocols"), "index.ts") },
  { find: /^miniprotocols\/(.*)/, replacement: path.join(pkg("miniprotocols"), "$1") },
  { find: /^bootstrap$/, replacement: path.join(pkg("bootstrap"), "index.ts") },
  { find: /^bootstrap\/(.*)/, replacement: path.join(pkg("bootstrap"), "$1") },
  { find: /^consensus$/, replacement: path.join(pkg("consensus"), "index.ts") },
  { find: /^consensus\/(.*)/, replacement: path.join(pkg("consensus"), "$1") },
  { find: /^dashboard$/, replacement: path.join(pkg("dashboard"), "index.ts") },
  { find: /^dashboard\/(.*)/, replacement: path.join(pkg("dashboard"), "$1") },
  { find: /^ffi$/, replacement: path.join(pkg("ffi"), "index.ts") },
  { find: /^ffi\/(.*)/, replacement: path.join(pkg("ffi"), "$1") },
  // Resolve `wasm-utils` to source so the high-level Crypto service +
  // CryptoOpError + initWasm are reachable. The source `index.ts`
  // pulls the wasm-bindgen bundle in as `import init from "../pkg/wasm_utils.js"`,
  // so the WASM module still ends up in the output — we just go
  // through the workspace layer instead of bypassing it.
  { find: /^wasm-utils$/, replacement: path.join(pkg("wasm-utils"), "index.ts") },
  { find: /^wasm-utils\/(.*)/, replacement: path.join(pkg("wasm-utils"), "$1") },
  {
    find: /^wasm-plexer$/,
    replacement: path.join(root, "packages/wasm-plexer/browser.js"),
  },
];

export default defineConfig({
  modules: ["@wxt-dev/module-solid"],
  manifest: {
    name: "Gerolamino",
    description: "In-browser Cardano node",
    // `unlimitedStorage` covers our IndexedDB usage (BlobStore quota
    // bypass); we intentionally do NOT request `storage` because the
    // chrome.storage.* surface is unused — state flows through the
    // Effect RPC streaming endpoint, not chrome.storage.session.
    // `alarms` keeps the SW alive during long bootstrap downloads;
    // `offscreen` lets us spawn the offscreen document for off-thread
    // CBOR decoding.
    permissions: ["unlimitedStorage", "alarms", "offscreen"],
    host_permissions: ["*://178.156.252.81/*", "*://decentralizationmaxi.io/*"],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  vite: () => ({
    resolve: {
      alias: workspaceAliases,
    },
  }),
});
