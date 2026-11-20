import { defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

// Builds ./gui-experimental: one prebuilt CommonJS file, because the desktop app
// cannot load a second chunk. Run from this directory: `npx vite build`.
export default defineConfig({
  plugins: [gui({ entry: "gui.tsx", outFile: "dist/gui-experimental.cjs" })],
});
