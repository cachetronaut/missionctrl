import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'packages/core/src/index.ts',
    'default-wiring': 'packages/default-wiring/src/index.ts',
    'surface-http': 'packages/surface-http/src/index.ts',
  },
  format: 'esm',
  dts: true,
  splitting: true,
  clean: true,
  outDir: 'dist',
  target: 'es2022',
});
