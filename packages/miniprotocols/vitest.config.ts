import { defineConfig } from "vitest/config";

const dir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

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
      "@": `${dir}/src`,
    },
  },
});
