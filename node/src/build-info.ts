// Version stamping (spec §10.5): `bun run build` writes a pregenerated
// `build-info.generated.ts` with `{version, commit, buildDate}` sourced from
// env/git — mirrors apps/cli's build script + `apps/cli/src/build-info.ts`
// pattern. That file is gitignored (matching apps/cli), so a checked-in
// `build-info.generated.d.ts` stub keeps `tsc` happy when it hasn't been
// generated yet.
//
// Unlike the CLI (whose fallback version is the literal string `'dev'`),
// running unbuilt (dev, `bun test`, `bun run src/index.ts`) here falls back
// to this package's own `package.json` version — so `amtp --version` and the
// MCP server info (`amtp mcp`'s `readPackageVersion`, spec §8.1) always
// report a real version even before the first `bun run build`.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface BuildInfo {
  version: string
  commit: string
  buildDate: string
}

function readPackageVersion(): string {
  try {
    const pkgPath = join(dirname(new URL(import.meta.url).pathname), '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

let generated: Partial<BuildInfo> = {}
try {
  generated = (await import('./build-info.generated')).generatedBuildInfo
} catch {
  generated = {}
}

export const buildInfo: BuildInfo = {
  version: generated.version ?? readPackageVersion(),
  commit: generated.commit ?? 'dev',
  buildDate: generated.buildDate ?? 'dev',
}
