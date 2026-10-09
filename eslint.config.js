import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: ["dist/**", "dist-local/**", "node_modules/**", "playwright-report/**", "test-results/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "scripts/**/*.{mjs,js}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooks,
    },
    rules: {
      // Hook ordering is a correctness invariant, not a style preference.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // The first lint rollout reports debt without turning existing legacy
      // factories and test fixtures into an unreviewable formatting migration.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Converged ownership modules get real type-aware Promise checks first;
    // legacy orchestration remains visible debt, not a blanket rule disable.
    files: [
      "src/server/runtime-pool.ts", "src/server/session-projection.ts", "src/server/sse-hub.ts",
      "src/server/services/session-copy-origin-actions.ts",
      "src/web/application/session-view-cache-writer.ts",
      "src/web/application/runtime-projection-writer.ts",
      "src/web/application/active-session-projection-writer.ts",
    ],
    languageOptions: {
      parserOptions: { project: ["./tsconfig.json", "./tsconfig.server.json"], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/server/services/session-copy-origin-actions.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
    },
  },
];
