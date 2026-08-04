// Human/`--json` rendering, mirroring `apps/cli/src/output.ts` (spec §7.1:
// "global `--json` (machine output; default is human-readable)").

export interface OutputOptions {
  json?: boolean
}

let globalOptions: OutputOptions = {}

export function setOutputOptions(options: OutputOptions): void {
  globalOptions = options
}

export function isJsonMode(): boolean {
  return !!globalOptions.json
}

/**
 * Render `data` as pretty JSON under `--json`; otherwise print `human` (a
 * single line, an array of lines, or — when omitted — `data` itself via
 * `console.log`).
 */
export function output(data: unknown, human?: string | Array<string | undefined>): void {
  if (globalOptions.json) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  if (typeof human === 'string') {
    console.log(human)
  } else if (Array.isArray(human)) {
    for (const line of human) {
      if (line !== undefined) console.log(line)
    }
  } else {
    console.log(data)
  }
}

const COLUMN_PADDING = 2

function displayWidth(s: string): number {
  return [...s].length
}

/** Render `items` as a fixed-width table under human output; the raw array under `--json`. */
export function outputTable<T extends object>(items: T[], columns: Array<keyof T & string>): void {
  if (globalOptions.json) {
    console.log(JSON.stringify(items, null, 2))
    return
  }
  if (items.length === 0) {
    console.log('(none)')
    return
  }

  const cell = (item: T, col: keyof T & string): string => String((item as Record<string, unknown>)[col] ?? '')

  const widths = columns.map((col) => {
    const headerW = displayWidth(col)
    const maxDataW = Math.max(0, ...items.map((item) => displayWidth(cell(item, col))))
    return Math.max(headerW, maxDataW, 1)
  })
  const pad = (s: string, w: number): string => {
    const len = displayWidth(s)
    return len >= w ? s : s + ' '.repeat(w - len)
  }
  const sep = widths.map((w) => '-'.repeat(w)).join(' '.repeat(COLUMN_PADDING))

  console.log(columns.map((c, i) => pad(c, widths[i])).join(' '.repeat(COLUMN_PADDING)))
  console.log(sep)
  for (const item of items) {
    console.log(columns.map((c, i) => pad(cell(item, c), widths[i])).join(' '.repeat(COLUMN_PADDING)))
  }
}

/** Errors exit 1 with `{"error": …}` under `--json` (spec §7.1). */
export function outputError(err: Error): never {
  if (globalOptions.json) {
    console.error(JSON.stringify({ error: err.message }))
  } else {
    console.error(`Error: ${err.message}`)
  }
  process.exit(1)
}
