import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// SWC is required: NestJS relies on `emitDecoratorMetadata`, which esbuild does not support.
const swcPlugin = swc.vite({
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorMetadata: true, legacyDecorator: true },
    target: 'es2022',
  },
  module: { type: 'es6' },
});

export default defineConfig({
  plugins: [swcPlugin],
  resolve: { tsconfigPaths: true },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['libs/**/*.ts', 'apps/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', 'apps/**/main.ts', '**/*.schema.ts', '**/*.module.ts'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['libs/**/*.test.ts', 'apps/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/*.e2e.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [
            'libs/**/*.integration.test.ts',
            'libs/**/*.e2e.test.ts',
            'apps/**/*.integration.test.ts',
            'apps/**/*.e2e.test.ts',
          ],
          globalSetup: ['./test/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
