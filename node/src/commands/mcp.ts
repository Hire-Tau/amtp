// `amtp mcp`: stdio MCP server (spec §8) exposing the 13 tools of
// ../mcp/tools.ts 1:1 over the ops/* layer — same code every one-shot CLI
// verb calls. Settled on `@modelcontextprotocol/sdk`'s `McpServer` +
// `StdioServerTransport` over hand-rolling JSON-RPC (§8.1): the SDK owns
// protocol-version negotiation. Because §8.2's tool schemas are raw JSON
// Schema (not zod), `tools/list` and `tools/call` are wired directly on
// McpServer's underlying `Server` (its `.server` property) rather than
// through the zod-typed `registerTool` API.

import { Command } from 'commander'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildInfo } from '../build-info'
import { getCliHome, openHomeDb } from '../context'
import { buildNodeEngine } from '../engine'
import { MCP_TOOLS } from '../mcp/tools'
import type { McpToolContext } from '../mcp/tools'
import { outputError } from '../output'

/**
 * Build the MCP server (not yet connected to a transport) — the testable
 * unit: constructs the server, registers `tools/list` + `tools/call`
 * against `MCP_TOOLS`, and returns it for the caller to `connect()`.
 */
export function buildMcpServer(ctx: McpToolContext): McpServer {
  const server = new McpServer({ name: 'amtp', version: buildInfo.version }, { capabilities: { tools: {} } })

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }))

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = MCP_TOOLS.find((t) => t.name === request.params.name)
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool: ${request.params.name}` }) }],
      }
    }
    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      const result = await tool.handler(ctx, args)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] }
    }
  })

  return server
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run the MCP stdio server exposing the 13 AMTP tools (spec §8) over @modelcontextprotocol/sdk')
    .action(async () => {
      try {
        const home = getCliHome()
        const db = openHomeDb(home)
        const engine = buildNodeEngine(db, home)
        const server = buildMcpServer({ db, home, engine })
        const transport = new StdioServerTransport()
        await server.connect(transport)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
