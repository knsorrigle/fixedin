import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: { entry: 'src/index.ts' },
  clean: true,
});
