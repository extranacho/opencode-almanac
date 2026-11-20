import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: `vitest` would otherwise load the GUI
// preset, which brings a browser environment the unit tests do not need.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
