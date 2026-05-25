import { defineConfig } from "tsup";

// Bundle the server to a single ESM file with a node shebang so it can be run
// directly via `npx @suverse/mcp-server`. Dependencies stay external (resolved
// from node_modules at runtime) — only our own source is bundled, which sidesteps
// ESM relative-import extension rules.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
