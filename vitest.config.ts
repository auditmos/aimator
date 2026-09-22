import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": "./src",
    },
  },
  test: {
    environment: "node",
    // The client's own tests live beside it, under `ui/`. Only the pure
    // readers are tested there, which is why the environment stays `node`: a
    // function that turns one stage's report into a bill and its prompts needs
    // no DOM, and the components around it are verified in a browser.
    include: ["src/**/*.test.ts", "ui/**/*.test.ts"],
  },
});
