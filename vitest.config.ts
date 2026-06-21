// Vitest config for the front-end unit tests (the Rust side uses `cargo test`).
// jsdom gives us `localStorage`, `document`, and `window` for the store /
// notification-dispatch tests. Tests live next to the code as `*.test.ts`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
