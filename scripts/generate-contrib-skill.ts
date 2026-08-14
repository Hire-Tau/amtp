/**
 * Derives contrib/claude-skills/amtp/SKILL.md from node/SKILL.md — the single
 * source of truth, which ships in the amtp-node npm package. The contrib copy
 * is what install.sh distributes to ~/.claude/skills, where relative links
 * cannot resolve, so every `](../<path>)` link is rewritten to an absolute
 * GitHub URL, the "in this repo" qualifier (false outside the repo) is
 * dropped, and a do-not-edit marker is injected after the frontmatter.
 *
 * Run: `bun scripts/generate-contrib-skill.ts`          # rewrite the contrib copy
 *      `bun scripts/generate-contrib-skill.ts --check`  # exit 1 if out of sync (CI)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const SOURCE = join(ROOT, 'node', 'SKILL.md')
const TARGET = join(ROOT, 'contrib', 'claude-skills', 'amtp', 'SKILL.md')
const BASE_URL = 'https://github.com/Hire-Tau/amtp/blob/main/'
const MARKER =
  '<!-- GENERATED FILE — edit node/SKILL.md and run: bun scripts/generate-contrib-skill.ts -->'

const source = readFileSync(SOURCE, 'utf8')

const withAbsoluteLinks = source.replaceAll(
  /\]\(\.\.\/([^)]+)\)( in this repo)?/g,
  (_match, path) => `](${BASE_URL}${path})`,
)
const generated = withAbsoluteLinks.replace(
  /^(---\n(?:.*\n)*?---\n)/,
  `$1\n${MARKER}\n`,
)
if (!generated.includes(MARKER)) {
  console.error(`${relative(ROOT, SOURCE)} has no frontmatter block to anchor the generated-file marker.`)
  process.exit(1)
}

if (process.argv.includes('--check')) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null
  if (current !== generated) {
    console.error(`${relative(ROOT, TARGET)} is out of sync with ${relative(ROOT, SOURCE)}.`)
    console.error('Regenerate it with: bun scripts/generate-contrib-skill.ts')
    process.exit(1)
  }
  console.log('contrib skill is in sync')
} else {
  writeFileSync(TARGET, generated)
  console.log(`wrote ${relative(ROOT, TARGET)}`)
}
