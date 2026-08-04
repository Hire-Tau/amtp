import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'

const SRC_DIR = dirname(new URL(import.meta.url).pathname)

// Matches ES import/export specifiers, e.g. import-from-quoted-string and bare side-effect imports.
const IMPORT_RE = /(?:import|export)(?:[^'"`]*?from)?\s*['"`]([^'"`]+)['"`]/g

// Matches dynamic-import and require call forms (e.g. dynamic import of a
// quoted specifier, or a require call), which the static IMPORT_RE above
// does not catch.
const DYNAMIC_IMPORT_RE = /(?:\bimport|\brequire)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g

function extractSpecifiers(contents: string): string[] {
  const specifiers: string[] = []
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(contents))) {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

function isAllowedSpecifier(spec: string, filename: string): boolean {
  if (spec === 'zod') return true
  // dev-only, test files only — not part of the package's runtime surface
  if (spec === 'bun:test') return filename.endsWith('.test.ts')
  if (spec.startsWith('node:')) return true
  if (spec.startsWith('.')) {
    // Relative import must stay inside the package — normalize away any
    // internal './..' juggling and reject if the result still climbs above
    // the package root (i.e. starts with '..').
    return !posix.normalize(spec).startsWith('..')
  }
  return false
}

describe('package purity', () => {
  const files = (readdirSync(SRC_DIR, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'))

  test('every src/**/*.ts file only imports zod, node:* builtins, or in-package relatives', () => {
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const contents = readFileSync(join(SRC_DIR, file), 'utf8')
      const specifiers = extractSpecifiers(contents)

      for (const spec of specifiers) {
        expect(isAllowedSpecifier(spec, file)).toBe(true)
      }
    }
  })

  test('extractSpecifiers catches static import/export, dynamic import(), and require() forms', () => {
    // Built via String.fromCharCode rather than written as literal quoted
    // specifiers so these fixtures don't themselves get picked up as real
    // imports when this very file is scanned by the test above.
    const q = String.fromCharCode(39) // '
    const staticImport = `import x from ${q}@example/shared${q}`
    const staticExport = `export * from ${q}../../shared/src/foo${q}`
    const dynamicImport = `import(${q}@example/shared${q})`
    const dynamicRequire = `require(${q}@example/shared${q})`

    expect(extractSpecifiers(staticImport)).toEqual(['@example/shared'])
    expect(extractSpecifiers(staticExport)).toEqual(['../../shared/src/foo'])
    expect(extractSpecifiers(dynamicImport)).toEqual(['@example/shared'])
    expect(extractSpecifiers(dynamicRequire)).toEqual(['@example/shared'])
  })

  test('extractSpecifiers catches backtick template-literal specifiers', () => {
    const bq = String.fromCharCode(96) // `
    const dynamicImportBacktick = `import(${bq}@example/shared${bq})`

    expect(extractSpecifiers(dynamicImportBacktick)).toEqual(['@example/shared'])
  })

  test('isAllowedSpecifier rejects package-escaping relative specifiers', () => {
    // A '.'-prefixed spec that only escapes after normalization (e.g. by
    // dipping into a sibling dir and back out past the package root) must
    // still be rejected, not just a bare leading '..'.
    expect(isAllowedSpecifier('./../../packages/shared/src/schemas', 'foo.ts')).toBe(false)
    expect(isAllowedSpecifier('..', 'foo.ts')).toBe(false)
    expect(isAllowedSpecifier('./canonical', 'foo.ts')).toBe(true)
  })

  test('isAllowedSpecifier scopes bun:test to test files only', () => {
    expect(isAllowedSpecifier('bun:test', 'foo.ts')).toBe(false)
    expect(isAllowedSpecifier('bun:test', 'foo.test.ts')).toBe(true)
  })
})
