import { defineConfig } from "vitest/config";
import path from "path";
import wasm from "vite-plugin-wasm";

const hasSnapshot = !!process.env["SNAPSHOT_PATH"];
const hasNetwork = !!process.env["CARDANO_NODE_HOST"];
const hasWasm = !!process.env["WASM_BUILT"];

export default defineConfig({
  plugins: [wasm()],
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.direnv/**",
      "**/.devenv/**",
      "**/old/**",
      "**/dist/**",
      // Skip snapshot-dependent tests unless SNAPSHOT_PATH is set
      ...(!hasSnapshot
        ? [
            "apps/bootstrap/src/__tests__/integration.test.ts",
            "apps/bootstrap/src/__tests__/full-stream-decode.test.ts",
            "apps/bootstrap/src/__tests__/chunk-reader.test.ts",
            "packages/ledger/src/__tests__/new-epoch-state.test.ts",
            "packages/ledger/src/__tests__/full-snapshot-coverage.test.ts",
          ]
        : []),
      // Skip network-dependent tests unless CARDANO_NODE_HOST is set
      ...(!hasNetwork
        ? [
            "packages/miniprotocols/src/__tests__/preprod.test.ts",
            "packages/miniprotocols/src/protocols/handshake/__tests__/Handshake.test.ts",
          ]
        : []),
      // Skip WASM-dependent tests unless WASM_BUILT is set
      ...(!hasWasm ? ["packages/miniprotocols/src/multiplexer/__tests__/multiplexer.test.ts"] : []),
    ],
    benchmark: {
      include: ["packages/*/src/**/*.bench.ts"],
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    watch: false,
  },
  resolve: {
    alias: {
      // miniprotocols internal alias
      "@": path.resolve(__dirname, "packages/miniprotocols/src"),
      // ledger package subpath alias (used by consensus/header-bridge)
      "ledger/lib/block/block": path.resolve(__dirname, "packages/ledger/src/lib/block/block.ts"),
      // workspace package aliases for cross-package imports
      // storage package subpath aliases
      "storage/blob-store/service": path.resolve(
        __dirname,
        "packages/storage/src/blob-store/service.ts",
      ),
      "storage/blob-store/keys": path.resolve(__dirname, "packages/storage/src/blob-store/keys.ts"),
      "storage/blob-store/index": path.resolve(
        __dirname,
        "packages/storage/src/blob-store/index.ts",
      ),
      "storage/blob-store/index.ts": path.resolve(
        __dirname,
        "packages/storage/src/blob-store/index.ts",
      ),
      "storage/services/index": path.resolve(__dirname, "packages/storage/src/services/index.ts"),
      "storage/services/immutable-db": path.resolve(
        __dirname,
        "packages/storage/src/services/immutable-db.ts",
      ),
      "storage/services/volatile-db": path.resolve(
        __dirname,
        "packages/storage/src/services/volatile-db.ts",
      ),
      "storage/services/ledger-db": path.resolve(
        __dirname,
        "packages/storage/src/services/ledger-db.ts",
      ),
      "storage/types/StoredBlock": path.resolve(
        __dirname,
        "packages/storage/src/types/StoredBlock.ts",
      ),
      "storage/services/chain-db": path.resolve(
        __dirname,
        "packages/storage/src/services/chain-db.ts",
      ),
      ffi: path.resolve(__dirname, "packages/ffi/src/index.ts"),
    },
  },
  server: {
    watch: {
      ignored: ["**/.direnv/**", "**/.devenv/**", "**/.context/**", "**/node_modules/**"],
    },
  },
});
