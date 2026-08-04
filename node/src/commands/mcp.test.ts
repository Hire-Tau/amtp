// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §8.1 (server
// info + `content`/`isError` tool-result shape) and §8.2 (13 tools).
//
// Exercises `buildMcpServer` through the real protocol — an in-process
// `Client` <-> `Server` pair over `InMemoryTransport` — rather than reaching
// into private request-handler internals, so these tests cover the exact
// wire behavior an MCP client sees (`tools/list`, and `tools/call`'s
// isError-wrapping convention on a thrown ops error).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createAmtpEngine } from 'amtp-engine'
import { buildAdapters } from '../adapters'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { MCP_TOOLS } from '../mcp/tools'
import { runInit } from '../ops/init'
import { register } from '../ops/registrations'
import { buildMcpServer, registerMcpCommand } from './mcp'
import { newProgram } from './test-helpers'

let workDir: string
let home: string
let db: Database
let client: Client

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-mcp-cmd-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  const init = runInit(home)
  db = openDb(dbPath(home))
  register(db, init.instanceId, { handle: 'alice' })

  const engine = createAmtpEngine(buildAdapters(db, home))
  const server = buildMcpServer({ db, home, engine })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
})

afterEach(async () => {
  await client.close()
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('amtp mcp (commander wiring)', () => {
  test('is registered with the expected shape', () => {
    const program = newProgram()
    registerMcpCommand(program)
    const mcp = program.commands.find((c) => c.name() === 'mcp')
    expect(mcp).toBeDefined()
    expect(mcp?.registeredArguments).toEqual([])
  })
})

describe('amtp mcp server registration', () => {
  test('tools/list exposes exactly MCP_TOOLS (the 13 spec §8.2 tools + 3 card tools)', async () => {
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(MCP_TOOLS.length)
    expect(tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort())
  })

  test('tools/list schemas round-trip the same additionalProperties:false shape registered locally', async () => {
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    for (const tool of MCP_TOOLS) {
      // `client.listTools()`'s inputSchema is typed to a narrower JSON Schema
      // shape than our `Record<string, unknown>`; the values are still
      // structurally identical (round-tripped over InMemoryTransport as JSON).
      expect(JSON.parse(JSON.stringify(byName.get(tool.name)?.inputSchema))).toEqual(
        JSON.parse(JSON.stringify(tool.inputSchema))
      )
    }
  })
})

describe('amtp mcp tools/call', () => {
  test('a happy-path call returns {content: [{type: "text", text: JSON}]}', async () => {
    const result = await client.callTool({ name: 'amtp_whoami', arguments: {} })
    expect(result.isError).toBeFalsy()
    const content = result.content as { type: string; text: string }[]
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('text')
    const parsed = JSON.parse(content[0].text) as { handles: { handle: string }[] }
    expect(parsed.handles.map((h) => h.handle)).toEqual(['alice'])
  })

  test('an ops error surfaces as isError:true with {"error": message} text, per §8.1 — not a JSON-RPC failure', async () => {
    const result = await client.callTool({ name: 'amtp_read_message', arguments: { message_id: 'ghost' } })
    expect(result.isError).toBe(true)
    const content = result.content as { type: string; text: string }[]
    const parsed = JSON.parse(content[0].text) as { error: string }
    expect(parsed.error).toMatch(/unknown message/)
  })

  test('calling an unknown tool name also surfaces as isError:true rather than throwing', async () => {
    const result = await client.callTool({ name: 'amtp_does_not_exist', arguments: {} })
    expect(result.isError).toBe(true)
    const content = result.content as { type: string; text: string }[]
    const parsed = JSON.parse(content[0].text) as { error: string }
    expect(parsed.error).toMatch(/unknown tool/)
  })
})
