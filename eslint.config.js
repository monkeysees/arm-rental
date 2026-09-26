import eslint from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "coverage/**",
      "node_modules/**",
      ".data/**",
      "experiments/**/target/**",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
];
