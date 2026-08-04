// Version stamping (spec §10.5): `amtp --version` and the MCP server info
// both surface `buildInfo.version`. Running unbuilt (as this test does — no
// `bun run build` has produced `build-info.generated.ts`), it must fall back
// to this package's own package.json version rather than a placeholder.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import { buildInfo } from './build-info'

const packageJson = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
  version: string
}

describe('build-info version stamping', () => {
  test('buildInfo.version falls back to package.json version when unbuilt', () => {
    expect(buildInfo.version).toBe(packageJson.version)
  })

  test('program.version() (wired exactly as src/index.ts wires it) embeds the package.json version', () => {
    // Doesn't import src/index.ts directly — that module calls
    // `program.parse()` at import time (real entrypoint side effect), which
    // would parse bun:test's own argv. Mirrors the exact `.version(...)`
    // call instead to test the wiring without that side effect.
    const program = new Command().version(`${buildInfo.version} (${buildInfo.commit}, ${buildInfo.buildDate})`)
    expect(program.version()).toContain(packageJson.version)
  })

  test('buildInfo.commit and buildDate fall back to "dev" when unbuilt', () => {
    expect(buildInfo.commit).toBe('dev')
    expect(buildInfo.buildDate).toBe('dev')
  })
})
