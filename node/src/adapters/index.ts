// §4 — assembles every sqlite port adapter (§4.1-§4.8) plus the delivery
// hooks (§4.9, src/hooks.ts) into the full `AmtpEnginePorts` the engine needs.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.

import type { Database } from 'bun:sqlite'
import type { AmtpEnginePorts } from 'amtp-engine'
import { buildDeliveryHooks } from '../hooks'
import type { DeliveryHooksOptions } from '../hooks'
import { buildAttachmentStore } from './attachments'
import { buildHandleDirectory } from './handles'
import { buildIdentityPort } from './identity'
import { buildOutboxStore } from './outbox'
import { buildPeerStore } from './peers'
import { buildPinStore } from './pins'
import { buildReceivePolicy } from './policy'
import { buildReplayLedger } from './replays'

export { buildAttachmentStore } from './attachments'
export { buildHandleDirectory } from './handles'
export { buildIdentityPort } from './identity'
export { buildOutboxStore } from './outbox'
export { buildPeerStore } from './peers'
export { buildPinStore } from './pins'
export { buildReceivePolicy } from './policy'
export { buildReplayLedger } from './replays'

export function buildAdapters(db: Database, home: string, deliveryOpts: DeliveryHooksOptions = {}): AmtpEnginePorts {
  return {
    identity: buildIdentityPort(db),
    peers: buildPeerStore(db),
    pins: buildPinStore(db),
    replays: buildReplayLedger(db),
    outbox: buildOutboxStore(db),
    attachments: buildAttachmentStore(db, home),
    handles: buildHandleDirectory(db),
    policy: buildReceivePolicy(db, home),
    delivery: buildDeliveryHooks(db, home, deliveryOpts),
  }
}
