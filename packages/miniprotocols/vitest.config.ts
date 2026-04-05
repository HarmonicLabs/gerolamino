import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["./old/**", "./.direnv/**", "./.devenv/**", "**/node_modules/**"],
    include: ["src/**/*.test.ts"],
    benchmark: {
      include: ["src/__tests__/benchmarks/**/*.bench.ts"],
      reporters: ["default"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
