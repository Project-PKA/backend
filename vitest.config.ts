import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // Subir o container do Postgres pode demorar na primeira vez.
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      // Pontos de entrada finos: não têm lógica própria para testar.
      exclude: ['src/server.ts', 'src/db/cli.ts', 'src/db/seed-cli.ts'],
      thresholds: { lines: 70, statements: 70, functions: 70, branches: 70 },
    },
  },
});
