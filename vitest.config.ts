import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // React 17+ automatic JSX runtime — matches what Next.js uses to compile
  // `apps/web/app/**/*.tsx`. Without it, importing a `.tsx` component from
  // a `.test.tsx` raises `ReferenceError: React is not defined` because
  // esbuild's default classic transform expects an explicit `React` in
  // scope. Added for P3B-05's `CycleDots` ARIA-role render test.
  esbuild: { jsx: "automatic" },
  // Mirror `apps/web/tsconfig.json` paths so vitest resolves the same `@/*`
  // alias Next.js uses. Required for P3C-12's indicator/inspector tests,
  // which transitively pull `ActionSheetShell` (uses `@/lib/device`).
  resolve: {
    alias: {
      "@/": `${path.resolve(__dirname, "apps/web")}/`,
    },
  },
  test: {
    include: ["{packages,apps}/**/test/**/*.test.{ts,tsx}"],
    environment: "node",
    passWithNoTests: false,
  },
});
