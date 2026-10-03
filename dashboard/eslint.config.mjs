import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "coverage/**",
    ],
  },
  {
    files: ["**/*.{js,jsx,mjs}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        console: "readonly",
        process: "readonly",
        crypto: "readonly",
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        fetch: "readonly",
        URL: "readonly",
        FormData: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
];
