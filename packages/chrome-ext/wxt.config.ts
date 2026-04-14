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
  { find: /^cbor-schema$/, replacement: path.join(pkg("cbor-schema"), "index.ts") },
  { find: /^cbor-schema\/(.*)/, replacement: path.join(pkg("cbor-schema"), "$1") },
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
  { find: /^lsm-tree$/, replacement: path.join(pkg("lsm-tree"), "index.ts") },
  { find: /^lsm-tree\/(.*)/, replacement: path.join(pkg("lsm-tree"), "$1") },
  { find: /^wasm-utils$/, replacement: path.join(root, "packages/wasm-utils/pkg/wasm_utils.js") },
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
    permissions: ["storage", "unlimitedStorage", "alarms", "offscreen"],
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
