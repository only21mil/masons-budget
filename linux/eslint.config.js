import js from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["dist/**", "dist-electron/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // The renderer must never reach for a Node primitive; if one appears here
      // it means the preload boundary has been widened.
      "no-restricted-globals": [
        "error",
        { name: "require", message: "The renderer has no Node access." },
        { name: "process", message: "The renderer has no Node access." },
      ],
    },
  },
  {
    files: ["electron/**/*.ts", "scripts/**/*.mjs", "*.config.{js,ts}"],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
)
