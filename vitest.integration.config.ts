import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    // Generating the test media in beforeAll can take a while on slow CI machines.
    hookTimeout: 300_000,
    fileParallelism: false
  }
})
