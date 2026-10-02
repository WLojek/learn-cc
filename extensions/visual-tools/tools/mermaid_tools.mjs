/**
 * Mermaid authoring loop for the mermaid-maker subagent — three tools that
 * share one session-scoped source file:
 *
 *   write_mermaid   — write the full Mermaid source to the session's file
 *   edit_mermaid    — exact-match old_text→new_text on that file (Edit semantics)
 *   render_mermaid  — render whatever is in the file → PNG, returned inline;
 *                     with `save_as`, also publish it into <project>/viz
 *
 * Served by the visual-tools MCP server (../index.mjs), which Claude Code
 * starts ONLY for the subagents that declare it in their `mcpServers:`
 * frontmatter (currently just mermaid-maker). All three names live in this
 * one file.
 *
 * Rendering shells out to the bundled @mermaid-js/mermaid-cli (`mmdc`) with a
 * puppeteer config pointing at an installed Chrome, so no Chromium download is
 * needed. Module-level session state persists across this server process's
 * tool calls and is naturally isolated from any parallel maker (each subagent
 * gets its own server process).
 */

import { fileURLToPath } from "node:url"
import {
  applyEdit,
  dirname,
  errorResult,
  existsSync,
  findChrome,
  join,
  mkdirSync,
  publish,
  readFileSync,
  run,
  snippetAround,
  textResult,
  writeBody,
  writeFileSync,
} from "./_common.mjs"

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const EXTENSIONS_DIR = dirname(dirname(TOOL_DIR))
const MMDC_BIN = join(EXTENSIONS_DIR, "node_modules", ".bin", "mmdc")
const GROUP = "mermaid"
const BODY_FILE = "diagram.mmd"
const RENDER_TIMEOUT_MS = 120_000

/** @type {{ workDir: string, bodyPath: string } | null} */
let session = null

export const mermaidTools = [
  // ── write_mermaid ──────────────────────────────────────────────────────────
  {
    name: "write_mermaid",
    title: "Write Mermaid",
    description:
      "Write the FULL Mermaid source to this session's managed file (your first " +
      "draft or a complete rewrite). You do NOT name the file; edit_mermaid and " +
      "render_mermaid act on the same one.\n\n" +
      "`source` is a complete Mermaid diagram, e.g. a `graph TD` / `graph LR` " +
      "flow, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`, " +
      "`mindmap`, or `timeline`. Writing does NOT render; call render_mermaid " +
      "when ready. For a small fix, prefer edit_mermaid over rewriting.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "The complete Mermaid diagram source (starts with the diagram type, e.g. `graph TD`).",
        },
      },
      required: ["source"],
    },
    async handler(params) {
      const source = String(params.source ?? "").trim()
      if (!source) return errorResult("`write_mermaid` requires a non-empty `source`.")
      session = writeBody(GROUP, BODY_FILE, source)
      const lines = source.split("\n").length
      return textResult(
        `Wrote ${lines}-line Mermaid source.\nCall render_mermaid to render it, or edit_mermaid to tweak it.`,
      )
    },
  },

  // ── edit_mermaid ───────────────────────────────────────────────────────────
  {
    name: "edit_mermaid",
    title: "Edit Mermaid",
    description:
      "Make a single exact-match replacement in this session's Mermaid source: " +
      "the same contract as the built-in Edit tool, locked to the one managed file. " +
      "`old_text` must appear EXACTLY ONCE (include surrounding context for " +
      "uniqueness); on 0 or >1 matches the call fails and nothing changes. Call " +
      "write_mermaid first. Editing does NOT render.",
    inputSchema: {
      type: "object",
      properties: {
        old_text: { type: "string", description: "Exact substring of the current source to replace (must match once)." },
        new_text: { type: "string", description: "Replacement text for `old_text`." },
      },
      required: ["old_text", "new_text"],
    },
    async handler(params) {
      if (!session || !existsSync(session.bodyPath)) {
        return errorResult("edit_mermaid: no source yet — call write_mermaid first.")
      }
      const current = readFileSync(session.bodyPath, "utf8")
      let edit
      try {
        edit = applyEdit(current, String(params.old_text ?? ""), String(params.new_text ?? ""))
      } catch (e) {
        return errorResult(e.message)
      }
      writeFileSync(session.bodyPath, edit.updated, "utf8")
      return textResult(
        "Applied edit. Updated region:\n```\n" + snippetAround(edit.updated, edit.index) + "\n```\nCall render_mermaid to see it.",
      )
    },
  },

  // ── render_mermaid ─────────────────────────────────────────────────────────
  {
    name: "render_mermaid",
    title: "Render Mermaid",
    description:
      "Render the CURRENT session Mermaid source to a PNG and return it inline so " +
      "you can SEE the diagram and iterate. You do NOT pass the source here; it " +
      "comes from the managed file; call write_mermaid first.\n\n" +
      "Iterate freely with no `save_as` (preview only). When the diagram is " +
      "correct and clean, call once more with `save_as` set to a short kebab-case " +
      "topic slug: that publishes the PNG into <project>/viz with a unique " +
      "filename and returns the filename to embed. On a render error this returns " +
      "the error text instead of an image; fix with edit_mermaid and re-render.",
    inputSchema: {
      type: "object",
      properties: {
        save_as: {
          type: "string",
          description:
            "Short kebab-case topic slug (e.g. 'internet-packets'). When set, the " +
            "rendered PNG is published to <project>/viz as viz-<slug>-<timestamp>.png " +
            "and the filename is returned. Omit for a preview-only render.",
        },
      },
    },
    async handler(params) {
      if (!session || !existsSync(session.bodyPath)) {
        return errorResult("render_mermaid: no source yet — call write_mermaid first.")
      }
      if (!existsSync(MMDC_BIN)) {
        return errorResult(
          `render_mermaid: mermaid-cli is not installed (${MMDC_BIN} missing). Run \`npm install\` in ${EXTENSIONS_DIR}.`,
        )
      }
      const { workDir, bodyPath } = session
      mkdirSync(workDir, { recursive: true })

      const chrome = findChrome()
      const cfgPath = join(workDir, "puppeteer.json")
      writeFileSync(
        cfgPath,
        JSON.stringify(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] }),
        "utf8",
      )

      const outPath = join(workDir, `render-${Date.now()}.png`)
      const res = await run(MMDC_BIN, ["-i", bodyPath, "-o", outPath, "-p", cfgPath, "-s", "2", "-b", "white"], {
        cwd: workDir,
        timeoutMs: RENDER_TIMEOUT_MS,
        env: { PUPPETEER_SKIP_DOWNLOAD: "1" },
      })

      if (res.code !== 0 || !existsSync(outPath)) {
        const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n")
        const note = res.timedOut ? "mmdc timed out.\n\n" : ""
        return textResult(
          `${note}Mermaid render FAILED — no image produced. Fix the source with edit_mermaid and call render_mermaid again.\n\nError:\n${detail}`,
        )
      }

      const image = { type: "image", data: readFileSync(outPath).toString("base64"), mimeType: "image/png" }

      if (params.save_as) {
        const { filename, path } = publish(outPath, String(params.save_as))
        return {
          content: [
            {
              type: "text",
              text: `Published to viz/.\nfilename: ${filename}\npath: ${path}\n\nLOOK at the diagram below to confirm it is correct before returning it.`,
            },
            image,
          ],
        }
      }

      return {
        content: [
          {
            type: "text",
            text: "Preview render (not yet saved). LOOK: are arrows/relationships correct, labels right, nothing cramped? Fix with edit_mermaid, or re-render with `save_as` to publish.",
          },
          image,
        ],
      }
    },
  },
]
