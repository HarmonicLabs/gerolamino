import { defineConfig } from "vitest/config";
import path from "path";

const hasLmdb = !!process.env["SNAPSHOT_PATH"];
const hasNetwork = !!process.env["CARDANO_NODE_HOST"];

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
      // Skip LMDB-dependent tests unless SNAPSHOT_PATH is set
      ...(!hasLmdb
        ? [
            "apps/bootstrap/src/__tests__/integration.test.ts",
            "apps/bootstrap/src/__tests__/lmdb-kv.test.ts",
            "apps/bootstrap/src/__tests__/full-stream-decode.test.ts",
            "apps/bootstrap/src/__tests__/chunk-reader.test.ts",
          ]
        : []),
      // Skip network-dependent tests unless CARDANO_NODE_HOST is set
      ...(!hasNetwork
        ? [
            "packages/miniprotocols/src/__tests__/preprod.test.ts",
            "packages/miniprotocols/src/protocols/handshake/__tests__/Handshake.test.ts",
          ]
        : []),
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
    },
  },
  server: {
    watch: {
      ignored: ["**/.direnv/**", "**/.devenv/**", "**/.context/**", "**/node_modules/**"],
    },
  },
});
