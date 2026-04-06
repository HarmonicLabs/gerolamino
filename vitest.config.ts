import { defineConfig } from "vitest/config";
import path from "path";

const hasLmdb = !!process.env["SNAPSHOT_PATH"];
const hasNetwork = !!process.env["CARDANO_NODE_HOST"];
const hasWasm = !!process.env["WASM_BUILT"];

export default defineConfig({
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
      ...(!hasLmdb
        ? [
            "apps/bootstrap/src/__tests__/integration.test.ts",
            "apps/bootstrap/src/__tests__/lmdb-kv.test.ts",
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
      // workspace package aliases for cross-package imports
      "storage/blob-store/service": path.resolve(__dirname, "packages/storage/src/blob-store/service.ts"),
      "storage/blob-store/keys": path.resolve(__dirname, "packages/storage/src/blob-store/keys.ts"),
      "storage/blob-store/index": path.resolve(__dirname, "packages/storage/src/blob-store/index.ts"),
      "storage/blob-store/index.ts": path.resolve(__dirname, "packages/storage/src/blob-store/index.ts"),
      "lsm-tree": path.resolve(__dirname, "packages/lsm-tree/src/index.ts"),
    },
  },
  server: {
    watch: {
      ignored: ["**/.direnv/**", "**/.devenv/**", "**/.context/**", "**/node_modules/**"],
    },
  },
});
