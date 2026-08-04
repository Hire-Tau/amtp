import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // composite:false — see protocol/tsup.config.ts (TS6307 in tsup's dts build).
  dts: { compilerOptions: { composite: false } },
  sourcemap: true,
  clean: true,
  // amtp-protocol is a dependency -> external by default; do not bundle it.
})
