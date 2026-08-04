// `amtp init` (spec §7.2): creates the home directory (0700), the sqlite db
// (0600) with the instance identity row, and a default config.json.
// Idempotent: re-running on an initialized home prints the existing identity
// and changes nothing else.

import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem } from 'amtp-protocol'
import { openDb } from '../db/open'
import { configPath, dbPath, ensureAmtpDirs } from '../home'

export interface InitResult {
  instanceId: string
  publicKeyPem: string
  alreadyInitialized: boolean
}

// §3.4 default config.json.
const DEFAULT_CONFIG = {
  serve: { host: '0.0.0.0', port: 2687, drainIntervalMs: 5000 },
  receive: { maxAttachmentBytes: 10_485_760, maxTotalStorageBytes: 10_737_418_240 },
  receivedRetentionMs: 3_600_000,
}

export function runInit(home: string): InitResult {
  ensureAmtpDirs(home)
  chmodSync(home, 0o700)

  const db = openDb(dbPath(home))
  try {
    chmodSync(dbPath(home), 0o600)

    const existing = db
      .query<
        { instance_id: string; public_key_pem: string },
        []
      >('SELECT instance_id, public_key_pem FROM identity WHERE id = 1')
      .get()
    if (existing) {
      return { instanceId: existing.instance_id, publicKeyPem: existing.public_key_pem, alreadyInitialized: true }
    }

    const { publicKeyPem, privateKeyPem } = generateInstanceKeyPair()
    const instanceId = instanceIdFromPublicKeyPem(publicKeyPem)
    db.run(
      'INSERT INTO identity (id, instance_id, public_key_pem, private_key_pem, created_at) VALUES (1, ?, ?, ?, ?)',
      [instanceId, publicKeyPem, privateKeyPem, Date.now()]
    )

    if (!existsSync(configPath(home))) {
      writeFileSync(configPath(home), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
    }

    return { instanceId, publicKeyPem, alreadyInitialized: false }
  } finally {
    db.close()
  }
}
