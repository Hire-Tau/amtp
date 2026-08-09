// Bun.serve framing over the engine API (§6). The node mounts at the ROOT —
// no `/api` prefix — so this module is a thin translation layer: pull
// headers/body off the Request, call the matching AmtpEngine method, and
// frame its typed result back into a Response with the EXACT status/body
// the original host's Hono routes use (that route file is the reference; the
// node must be wire-indistinguishable except for the mount prefix).
//
// A hand-rolled matcher is deliberate here (§6): five routes plus a 404
// fallback don't warrant a router dependency, and the engine already returns
// `{httpStatus, body}` for the receive path — the host only frames it.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §6.

import type { AmtpEngine } from 'amtp-engine'
import { AMTP_HEADER_INSTANCE, AMTP_HEADER_SIGNATURE, AMTP_HEADER_TIMESTAMP } from 'amtp-protocol'

export interface BuildServerOptions {
  hostname?: string
  /** `0` binds an ephemeral port; read the actual bound port off the
   *  returned server's `.port` (spec §5.2, `--port 0` support). */
  port?: number
}

// `:id` / `:handle` are single path segments — `[^/]+` both requires at
// least one character and (by construction) excludes '/', so a trailing
// slash or an extra segment falls through to the 404 fallback rather than
// matching (spec §6: "`:id` and `:handle` are single path segments").
const ATTACHMENT_PATH_RE = /^\/amtp\/attachments\/([^/]+)$/
const AGENT_KEY_PATH_RE = /^\/amtp\/agents\/([^/]+)\/key$/
const AGENT_CARD_PATH_RE = /^\/amtp\/agents\/([^/]+)\/card$/

function unauthorized(): Response {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

function notFound(): Response {
  return Response.json({ error: 'Not found' }, { status: 404 })
}

/**
 * Auth for a bodyless signed GET (`GET /amtp/handles`, `GET
 * /amtp/attachments/:id`): headers short-circuit before calling the engine
 * (mirrors `requirePeerSignatureGet`'s header-presence check), then
 * `engine.verifySignedGet` over the actual observed pathname — which is why
 * this is conformant under any mount prefix (spec §6).
 */
async function verifySignedGetRequest(
  engine: AmtpEngine,
  req: Request,
  path: string,
  routePath: string
): Promise<{ ok: true; peerInstanceId: string } | { ok: false }> {
  const instanceHeader = req.headers.get(AMTP_HEADER_INSTANCE) ?? undefined
  const signatureHeader = req.headers.get(AMTP_HEADER_SIGNATURE) ?? undefined
  const timestampHeader = req.headers.get(AMTP_HEADER_TIMESTAMP) ?? undefined
  return engine.verifySignedGet({ method: 'GET', path, routePath, instanceHeader, signatureHeader, timestampHeader })
}

/**
 * Build the node's HTTP receive host as a `Bun.serve` instance. Exported (not
 * just invoked from `commands/serve.ts`) so in-process tests can spin one up
 * against a temp home without going through the CLI.
 */
export function buildServer(engine: AmtpEngine, opts: BuildServerOptions = {}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      if (method === 'GET' && path === '/healthz') {
        return Response.json({ ok: true })
      }

      if (method === 'GET' && path === '/amtp/identity') {
        return Response.json(await engine.getIdentity())
      }

      if (method === 'POST' && path === '/amtp/inbox') {
        // Headers short-circuit BEFORE the raw body is buffered: an
        // unauthenticated probe must not force a full body read (spec §6).
        const instanceHeader = req.headers.get(AMTP_HEADER_INSTANCE) ?? undefined
        const signatureHeader = req.headers.get(AMTP_HEADER_SIGNATURE) ?? undefined
        if (!instanceHeader || !signatureHeader) return unauthorized()

        // The exact bytes the transport signature covers (AMTP.md §6.1),
        // read ONCE and passed to the engine untouched.
        const rawBody = await req.text()
        const auth = await engine.verifyInboxPost({ instanceHeader, signatureHeader, rawBody })
        if (!auth.ok) return unauthorized()

        const result = await engine.receiveEnvelope({ peerInstanceId: auth.peerInstanceId, rawBody })
        return Response.json(result.body, { status: result.httpStatus })
      }

      const attachmentMatch = method === 'GET' ? ATTACHMENT_PATH_RE.exec(path) : null
      if (attachmentMatch) {
        const attachmentId = attachmentMatch[1]
        const auth = await verifySignedGetRequest(engine, req, path, `/amtp/attachments/${attachmentId}`)
        if (!auth.ok) return unauthorized()

        // Raw interpolation — NOT decodeURIComponent'd — matching the
        // engine's own raw-interpolation pull URL (spec §6, engine §4.4
        // step 2); unlike the agent-key handle below, this segment is never
        // decoded.
        const result = await engine.serveAttachment({ peerInstanceId: auth.peerInstanceId, attachmentId })
        if (!result.found) return notFound()

        // `new Uint8Array(bytes)` wrapping mirrors the reference route (a bare
        // Buffer is not a valid BodyInit under tsc).
        return new Response(new Uint8Array(result.bytes), {
          status: 200,
          headers: { 'content-type': result.contentType, 'content-length': String(result.byteSize) },
        })
      }

      if (method === 'GET' && path === '/amtp/handles') {
        const auth = await verifySignedGetRequest(engine, req, path, '/amtp/handles')
        if (!auth.ok) return unauthorized()
        return Response.json(await engine.listHandles())
      }

      const agentKeyMatch = method === 'GET' ? AGENT_KEY_PATH_RE.exec(path) : null
      if (agentKeyMatch) {
        let handle: string
        try {
          handle = decodeURIComponent(agentKeyMatch[1])
        } catch {
          return notFound()
        }
        const result = await engine.serveAgentKey(handle)
        if (!result.found) return notFound()
        // The `found` discriminant is stripped, never serialized (spec §6).
        const { handle: foundHandle, instanceId, identityPublicKey } = result
        return Response.json({ handle: foundHandle, instanceId, identityPublicKey })
      }

      const agentCardMatch = method === 'GET' ? AGENT_CARD_PATH_RE.exec(path) : null
      if (agentCardMatch) {
        let handle: string
        try {
          handle = decodeURIComponent(agentCardMatch[1])
        } catch {
          return notFound()
        }
        const result = await engine.serveAgentCard(handle)
        if (!result.found) return notFound()
        return Response.json(result.signedCard)
      }

      return notFound()
    },
  })
}
