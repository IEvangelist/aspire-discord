import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig({
  files: ["apphost.mts", "deployment-pipeline.mts", "test/**/*.mts"],
  extends: [tseslint.configs.strictTypeChecked],
  languageOptions: {
    parserOptions: {
      project: "./tsconfig.apphost.json",
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/no-floating-promises": [
      "error",
      { checkThenables: true },
    ],
    "@typescript-eslint/no-misused-promises": "error",
  },
});
