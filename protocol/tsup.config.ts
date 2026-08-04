import { defineConfig } from 'tsup'

// One entry per subpath export in package.json — keep in sync.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/address.ts',
    'src/canonical.ts',
    'src/envelope.ts',
    'src/constants.ts',
    'src/get-auth.ts',
    'src/crypto.ts',
    'src/card.ts',
    'src/jcs.ts',
  ],
  format: ['esm'],
  // composite:false — the root tsconfig sets composite:true for editor/project
  // builds, but tsup's synthetic dts project has no file list, so composite
  // trips TS6307.
  dts: { compilerOptions: { composite: false } },
  sourcemap: true,
  clean: true,
})
