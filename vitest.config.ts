import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The Worker code uses only web-standard globals (Request, Response,
    // crypto, fetch), all of which Node 20+ provides natively. Running in the
    // plain node environment keeps the suite fast (no workerd boot per file)
    // while still exercising the real handler end to end.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
});
