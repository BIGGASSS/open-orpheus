import adapter from "@sveltejs/adapter-static";
import type { Config } from "@sveltejs/kit";
import pkg from "../package.json" with { type: "json" };

const config: Config = {
  kit: {
    // SvelteKit otherwise embeds Date.now(), making identical builds differ.
    version: { name: pkg.version },
    adapter: adapter({
      pages: "../.vite/build/gui",
    }),
    alias: {
      $bridge: "../src/bridge",
      $sharedTypes: "../types",
    },
  },
  vitePlugin: {
    dynamicCompileOptions: ({ filename }: { filename: string }) =>
      filename.includes("node_modules") ? undefined : { runes: true },
  },
};

export default config;
