import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const EXTENSIONS_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const open = new Set()

/** Close every server still running (a failed assertion skips a test's own close). */
export async function closeAll() {
  for (const close of [...open]) await close()
}

/**
 * Start one of our MCP servers the way Claude Code does (stdio) and connect a
 * client to it. `answer(request)` plays the user: it receives every
 * elicitation request and returns `{ action, content }`. Omit it to connect a
 * client WITHOUT the elicitation capability (a non-interactive host).
 */
export async function connect(script, { args = [], answer } = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), "learn-test-"))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(EXTENSIONS_DIR, script), ...args],
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    stderr: "pipe",
  })
  const client = new Client(
    { name: "test-host", version: "0.0.0" },
    { capabilities: answer ? { elicitation: { form: {} } } : {} },
  )
  const dialogs = []
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      dialogs.push(request.params)
      return answer(request.params, dialogs.length - 1)
    })
  }
  await client.connect(transport)
  const close = async () => {
    open.delete(close)
    await client.close()
    rmSync(projectDir, { recursive: true, force: true })
  }
  open.add(close)
  return { client, dialogs, projectDir, close }
}

/** Call a tool as Claude Code does, including the tool_use id in `_meta`. */
export function call(client, name, args, toolUseId = "toolu_test_0001") {
  return client.callTool({ name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } })
}

export const text = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
