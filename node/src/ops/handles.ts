// `amtp handles <peer>` (spec §7.2): a signed GET to a peer, listing its
// published handles as full `amtp://` addresses.

import type { Database } from 'bun:sqlite'
import type { AmtpEngine } from 'amtp-engine'
import { formatAmtpAddress } from 'amtp-protocol'
import { resolvePeer } from './peers'

export interface RemoteHandle {
  handle: string
  address: string
  name?: string
  description?: string
}

export async function fetchPeerHandles(engine: AmtpEngine, db: Database, peerRef: string): Promise<RemoteHandle[]> {
  const peer = resolvePeer(db, peerRef)
  if (!peer) throw new Error(`unknown peer: ${peerRef}`)

  const result = await engine.fetchPeerHandles({ peerBaseUrl: peer.baseUrl })
  if (!result.ok) throw new Error(`failed to fetch handles from peer "${peerRef}" (${peer.baseUrl})`)

  return result.handles.map((h) => {
    const item: RemoteHandle = { handle: h.handle, address: formatAmtpAddress(peer.instanceId, h.handle) }
    if (h.name !== undefined) item.name = h.name
    if (h.description !== undefined) item.description = h.description
    return item
  })
}
