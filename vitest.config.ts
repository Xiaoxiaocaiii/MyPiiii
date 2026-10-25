import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/bin.ts', 'src/**/index.ts'],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
