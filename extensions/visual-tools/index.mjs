#!/usr/bin/env node
/**
 * visual-tools
 *
 * A self-contained MCP server that serves the maker subagents' authoring
 * tools — and does nothing else:
 *
 *   • write_mermaid / edit_mermaid / render_mermaid
 *       (tools/mermaid_tools.mjs) — the mermaid-maker's authoring loop: write a
 *       Mermaid source, exact-match edit it, render whatever is currently in
 *       the managed file to a PNG (via the bundled @mermaid-js/mermaid-cli and
 *       an installed Chrome), return the PNG inline for inspection, and — when
 *       given `save_as` — publish it into <project>/viz with a unique name.
 *   • write_svg / edit_svg / render_svg
 *       (tools/svg_tools.mjs) — the svg-maker's authoring loop: same shape, but
 *       renders hand-written SVG to a PNG via rsvg-convert (fallbacks:
 *       ImageMagick, then headless Chrome).
 *
 * ── How the tools reach ONLY the makers ─────────────────────────────────────
 * In pi, interactive-subagents launched each child with --no-extensions plus
 * `-e <path>` for the tools in its `tools:` frontmatter. The Claude Code
 * equivalent is an INLINE `mcpServers:` entry in the subagent's frontmatter:
 * Claude Code starts this server when the subagent starts and stops it when
 * the subagent finishes, and the main session never sees these tools. Each
 * maker passes a group argument so its server exposes only its own trio:
 *
 *   node index.mjs mermaid   → write_mermaid, edit_mermaid, render_mermaid
 *   node index.mjs svg       → write_svg, edit_svg, render_svg
 *   node index.mjs           → all six
 *
 * One server process per subagent means module-level session state (the
 * managed source file) is naturally isolated between parallel makers.
 */

import { serveTools } from "../_mcp.mjs"
import { mermaidTools } from "./tools/mermaid_tools.mjs"
import { svgTools } from "./tools/svg_tools.mjs"

const groups = { mermaid: mermaidTools, svg: svgTools }
const group = process.argv[2]
const tools = groups[group] ?? [...mermaidTools, ...svgTools]

await serveTools({ name: "visual-tools", version: "0.1.0", tools })
