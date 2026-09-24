import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  { ignores: ["**/dist/**", "**/node_modules/**", "clients/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser, parserOptions: { sourceType: "module" } },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
];
