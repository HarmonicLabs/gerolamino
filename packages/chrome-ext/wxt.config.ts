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
  // The package's directory is `packages/ffi/` but its npm name is
  // `lsm-ffi` (per `packages/ffi/package.json#name`). Map both
  // bare-name forms — `from "ffi"` for legacy paths still in tree
  // and `from "lsm-ffi"` (the canonical name) — to the same source.
  // Without `lsm-ffi`'s alias Vite walks node_modules to find the
  // package and that walk surprises Rolldown's chunker with a stray
  // solid-js import attempt from `lsm-wasm/blob-store.ts` (which is
  // not solid-js related — the JSX-runtime injection from
  // `jsxImportSource: solid-js` leaks the symbol onto every
  // transpiled .ts file in the workspace). The companion `solid-js`
  // dep on the root `package.json` ensures Bun hoists it to the
  // top-level `node_modules/` so any workspace package's walk-up
  // resolves it.
  { find: /^ffi$/, replacement: path.join(pkg("ffi"), "index.ts") },
  { find: /^ffi\/(.*)/, replacement: path.join(pkg("ffi"), "$1") },
  { find: /^lsm-ffi$/, replacement: path.join(pkg("ffi"), "index.ts") },
  { find: /^lsm-ffi\/(.*)/, replacement: path.join(pkg("ffi"), "$1") },
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
    // Chrome 124+ ships the WORKERS offscreen Reason (indefinite
    // lifetime), Chrome 116+ ships `runtime.getContexts()` for race-free
    // offscreen lifecycle introspection, and Chrome 126+ fixes the
    // bad-URL-on-createDocument ghost-document issue. 124 covers the
    // floor we depend on; older Chromes would hit the AUDIO_PLAYBACK
    // 30-second timeout on our daemon and silently corrupt the manager.
    minimum_chrome_version: "124",
    // `unlimitedStorage` covers our IndexedDB usage (BlobStore quota
    // bypass); we intentionally do NOT request `storage` because the
    // chrome.storage.* surface is unused — state flows through the
    // Effect RPC streaming endpoint, not chrome.storage.session.
    // `alarms` keeps the SW alive during long bootstrap downloads;
    // `offscreen` lets us spawn the offscreen document for off-thread
    // CBOR decoding.
    // `storage` covers `chrome.storage.local` (used by the popup setup
    // form to persist the chosen `BootstrapMode` + serverUrl); the SW
    // reads the same key on startup before opening any WebSocket.
    permissions: ["unlimitedStorage", "alarms", "offscreen", "storage"],
    // The relay-proxy WS endpoint runs on the same host as the browser
    // (override at build time via `BOOTSTRAP_URL` env var; see the
    // `define` block below). Browsers require explicit
    // `host_permissions` for WS connections to a different origin
    // from a service worker.
    host_permissions: ["*://localhost/*", "*://127.0.0.1/*"],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  // `__BOOTSTRAP_URL__` is the relay-proxy base URL — declared in
  // `entrypoints/offscreen/bootstrap-sync.ts` and rewritten to a
  // literal here at build time. `Config.string` would require a
  // runtime `process.env`, which doesn't exist in the browser
  // bundle. Override at build time via:
  //   BOOTSTRAP_URL=ws://localhost:3040 bunx --bun wxt build --mode development
  vite: () => ({
    resolve: {
      alias: workspaceAliases,
    },
    define: {
      __BOOTSTRAP_URL__: JSON.stringify(
        process.env.BOOTSTRAP_URL ?? "ws://localhost:3040",
      ),
    },
    // Worker bundling — emit each `new Worker(new URL("./workers/X.ts",
    // import.meta.url), { type: "module" })` as a separate ES-module
    // chunk under `chunks/` rather than inlining the raw `.ts` source
    // as a `data:video/mp2t;base64,…` URL. The data-URL form fails in
    // MV3 extensions on two counts:
    //   1. CSP `script-src 'self' 'wasm-unsafe-eval'` rejects `data:`
    //      workers (worker-src falls back to script-src; data: isn't
    //      in the allow-list).
    //   2. The `.ts` extension serializes as `video/mp2t` (MPEG-2
    //      Transport Stream), so Chrome's "Strict MIME type checking
    //      for module scripts" rejects it as non-JavaScript.
    // `format: "es"` makes Vite emit module workers (matches the
    // `{ type: "module" }` option in the `new Worker(...)` calls).
    worker: {
      format: "es",
    },
    // Disable inline-asset emission entirely for the extension build.
    // The Vite default (4 KiB threshold) inlines small assets as
    // data: URLs which collides with the MV3 CSP — and since every
    // referenced file under `entrypoints/` resolves to a relative
    // path the extension can serve directly, there's no benefit to
    // inlining.
    build: {
      assetsInlineLimit: 0,
    },
  }),
});
