// buildNodeEngine(db, home): wires the sqlite port adapters (§4) into the
// engine factory. Late-bound fetch per §2 — the `fetch` option is
// deliberately omitted so every network op resolves `globalThis.fetch` at
// call time (the engine's own default), never a reference captured here.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.

import type { Database } from 'bun:sqlite'
import { createAmtpEngine } from 'amtp-engine'
import type { AmtpEngine } from 'amtp-engine'
import { buildAdapters } from './adapters'

export interface BuildNodeEngineOptions {
  /** Default: no-op. `amtp serve` wires stderr lines here; one-shot verbs
   *  and tests leave it as the no-op default (spec §4, "Process topology"). */
  logger?: (level: 'info' | 'warn', message: string) => void
}

export function buildNodeEngine(db: Database, home: string, opts: BuildNodeEngineOptions = {}): AmtpEngine {
  const ports = buildAdapters(db, home, { logger: opts.logger })
  return createAmtpEngine(ports, { logger: opts.logger })
}
