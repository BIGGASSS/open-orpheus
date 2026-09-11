import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__test__/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "modules/*"],
  },
});
