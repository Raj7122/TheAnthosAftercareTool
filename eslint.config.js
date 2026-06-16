// ESLint 9.x flat config (PF-07 baseline).
//
// Plugin set is intentionally limited to the deps named in the PF-07 ticket:
// @typescript-eslint/*, eslint-plugin-security, eslint-plugin-jsx-a11y,
// eslint-plugin-no-secrets. Next.js-specific lint rules (eslint-config-next)
// are deliberately omitted; add via a follow-up ticket if/when needed.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
import jsxA11y from "eslint-plugin-jsx-a11y";
import noSecrets from "eslint-plugin-no-secrets";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "apps/web/public/**",
      "apps/web/next-env.d.ts",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    plugins: {
      security,
      "no-secrets": noSecrets,
    },
    rules: {
      ...security.configs.recommended.rules,
      "no-secrets/no-secrets": ["error", { tolerance: 4.2 }],
      // Allow underscore-prefixed unused names. Lets implementations of
      // typed interfaces declare the full parameter list (so a future
      // maintainer adding logic that needs the arg doesn't have to widen
      // the signature first) without tripping no-unused-vars.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.{tsx,jsx}"],
    plugins: { "jsx-a11y": jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
    },
    languageOptions: {
      ...jsxA11y.flatConfigs.recommended.languageOptions,
    },
  },
);
