import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        r2Buckets: ["BUCKET"],
        bindings: {
          HMAC_KEY: "test-hmac-key-0123456789abcdef0123456789abcdef",
          IDEM_KEY: "test-idem-key-0123456789abcdef0123456789abcdef",
          IP_SALT: "test-ip-salt",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
