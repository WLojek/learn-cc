/**
 * Minimal stdio MCP server around a list of tool specs:
 *
 *   { name, title, description, inputSchema, _meta?, handler(args, ctx) }
 *
 * `ctx` gives a handler what the pi ExtensionAPI used to: the abort signal,
 * the Claude Code tool_use id of the call, and a way to show the user a
 * dialog (MCP elicitation) — the stand-in for ctx.ui.custom()/ctx.ui.editor().
 *
 * `ctx.saveTranscript()` reports progress on the running call. Interactive
 * Claude Code otherwise writes the assistant's text to the session transcript
 * only after the call finishes; a progress notification makes it write it
 * right away (measured: ~0.6s instead of after the dialog). The md-log hook
 * reads the transcript, so this is what gets the lesson text into the log
 * before the learner answers — the way pi logged it on message end.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { DIALOG_TIMEOUT_MS } from "./_ui.mjs"

/** Claude Code sends the model's tool_use id with every call in `_meta`. */
const TOOL_USE_ID_META_KEY = "claudecode/toolUseId"

export async function serveTools({ name, version, instructions, tools }) {
  const server = new Server(
    { name, version },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  )
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool._meta ? { _meta: tool._meta } : {}),
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name)
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true }
    }
    const progressToken = request.params._meta?.progressToken
    const ctx = {
      signal: extra.signal,
      toolUseId: request.params._meta?.[TOOL_USE_ID_META_KEY],
      canElicit: Boolean(server.getClientCapabilities()?.elicitation?.form),
      elicit: (params) => server.elicitInput(params, { signal: extra.signal, timeout: DIALOG_TIMEOUT_MS }),
      saveTranscript: async (message = "waiting for your answer") => {
        if (progressToken === undefined) return
        try {
          await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: 0, message } })
        } catch {
          // Best effort: the dialog still works, the md-log just catches up later.
        }
      },
    }
    try {
      return await tool.handler(request.params.arguments ?? {}, ctx)
    } catch (e) {
      return { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
  // The SDK's stdio transport ignores EOF, and a pending dialog would keep this
  // process alive for days if Claude Code died without signalling it.
  process.stdin.on("end", () => process.exit(0))
  return server
}
