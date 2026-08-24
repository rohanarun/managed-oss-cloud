import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // PostgreSQL test files share TEST_DATABASE_URL and include database-wide
    // cleanup, so their file lifecycles must not overlap.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
