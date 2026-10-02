/**
 * SVG authoring loop for the svg-maker subagent — three tools that share one
 * session-scoped source file:
 *
 *   write_svg   — write the full SVG source to the session's file
 *   edit_svg    — exact-match old_text→new_text on that file (Edit semantics)
 *   render_svg  — render whatever is in the file → PNG, returned inline; with
 *                 `save_as`, also publish it into <project>/viz
 *
 * Served by the visual-tools MCP server (../index.mjs), which Claude Code
 * starts ONLY for the subagents that declare it in their `mcpServers:`
 * frontmatter (currently just svg-maker). All three names live in this one
 * file.
 *
 * Rendering shells out to rsvg-convert (librsvg — good system-font handling),
 * falling back to ImageMagick's `magick`. When neither is installed it uses
 * headless Chrome via the puppeteer that @mermaid-js/mermaid-cli already
 * installs — so SVG works even on a machine with neither system binary. Module-level session state
 * persists across this server process's tool calls, isolated from any
 * parallel maker.
 */

import {
  applyEdit,
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

const GROUP = "svg"
const BODY_FILE = "diagram.svg"
const RENDER_TIMEOUT_MS = 60_000

/** @type {{ workDir: string, bodyPath: string } | null} */
let session = null

/** Last-resort renderer: screenshot the SVG in headless Chrome at 2x. */
async function renderWithChrome(svgPath, outPath) {
  let puppeteer
  try {
    puppeteer = (await import("puppeteer")).default
  } catch {
    return { ok: false, error: "puppeteer is not installed (run `npm install` in the extensions folder)" }
  }
  const chrome = findChrome()
  let browser
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox"],
      ...(chrome ? { executablePath: chrome } : {}),
    })
    const page = await browser.newPage()
    // The SVG is model-written: render it as a static picture. No scripts, and
    // nothing is fetched from the network or disk (inline data: URLs only).
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    page.on("request", (request) => (/^(data|about):/.test(request.url()) ? request.continue() : request.abort()))
    await page.setViewport({ width: 2400, height: 2400, deviceScaleFactor: 2 })
    const svg = readFileSync(svgPath, "utf8")
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`,
      { waitUntil: "load", timeout: RENDER_TIMEOUT_MS },
    )
    const el = await page.$("svg")
    if (!el) return { ok: false, error: "no <svg> element found in the source" }
    await el.screenshot({ path: outPath })
    return existsSync(outPath) ? { ok: true } : { ok: false, error: "Chrome produced no image" }
  } catch (e) {
    return { ok: false, error: `headless Chrome: ${e?.message ?? e}` }
  } finally {
    await browser?.close().catch(() => {})
  }
}

/** Render an SVG file to PNG via rsvg-convert, falling back to magick (Chrome when neither is installed). */
async function renderSvg(svgPath, outPath, workDir) {
  // rsvg-convert renders at the SVG's intrinsic size; -z 2 doubles it for crispness.
  const res = await run("rsvg-convert", ["-z", "2", svgPath, "-o", outPath], {
    cwd: workDir,
    timeoutMs: RENDER_TIMEOUT_MS,
  })
  if (res.code === 0 && existsSync(outPath)) return { ok: true, res }
  // Fallback: ImageMagick. -density 192 (~2x of 96dpi) for a crisp raster.
  const magick = await run("magick", ["-density", "192", "-background", "white", svgPath, outPath], {
    cwd: workDir,
    timeoutMs: RENDER_TIMEOUT_MS,
  })
  if (magick.code === 0 && existsSync(outPath)) return { ok: true, res: magick }
  // A tool that ran and rejected the SVG reported a real error — return it
  // rather than let Chrome's lenient parser paper over broken markup.
  if (res.code !== null) return { ok: false, res }
  if (magick.code !== null) return { ok: false, res: magick }
  // Neither is installed: fall back to headless Chrome.
  const chrome = await renderWithChrome(svgPath, outPath)
  if (chrome.ok) return { ok: true, res: magick }
  return { ok: false, res: { ...magick, stderr: chrome.error } }
}

export const svgTools = [
  // ── write_svg ──────────────────────────────────────────────────────────────
  {
    name: "write_svg",
    title: "Write SVG",
    description:
      "Write the FULL SVG source to this session's managed file (your first draft " +
      "or a complete rewrite). You do NOT name the file; edit_svg and render_svg " +
      "act on the same one.\n\n" +
      "`source` is a complete `<svg ...>…</svg>` document with an explicit width/" +
      "height (or viewBox), readable font sizes, and a light or transparent " +
      "background. Writing does NOT render; call render_svg when ready. For a " +
      "small fix, prefer edit_svg over rewriting.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The complete SVG document, from `<svg` to `</svg>`." },
      },
      required: ["source"],
    },
    async handler(params) {
      const source = String(params.source ?? "").trim()
      if (!source) return errorResult("`write_svg` requires a non-empty `source`.")
      if (!source.includes("<svg")) return errorResult("`write_svg`: source must be a complete <svg>…</svg> document.")
      session = writeBody(GROUP, BODY_FILE, source)
      const lines = source.split("\n").length
      return textResult(`Wrote ${lines}-line SVG source.\nCall render_svg to render it, or edit_svg to tweak it.`)
    },
  },

  // ── edit_svg ───────────────────────────────────────────────────────────────
  {
    name: "edit_svg",
    title: "Edit SVG",
    description:
      "Make a single exact-match replacement in this session's SVG source: the " +
      "same contract as the built-in Edit tool, locked to the one managed file. " +
      "`old_text` must appear EXACTLY ONCE (include surrounding context for " +
      "uniqueness); on 0 or >1 matches the call fails and nothing changes. Call " +
      "write_svg first. Editing does NOT render.",
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
        return errorResult("edit_svg: no source yet — call write_svg first.")
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
        "Applied edit. Updated region:\n```\n" + snippetAround(edit.updated, edit.index) + "\n```\nCall render_svg to see it.",
      )
    },
  },

  // ── render_svg ─────────────────────────────────────────────────────────────
  {
    name: "render_svg",
    title: "Render SVG",
    description:
      "Render the CURRENT session SVG source to a PNG and return it inline so you " +
      "can SEE the picture and iterate. You do NOT pass the source here; it comes " +
      "from the managed file; call write_svg first.\n\n" +
      "Iterate freely with no `save_as` (preview only). When the picture is " +
      "correct and clean, call once more with `save_as` set to a short kebab-case " +
      "topic slug: that publishes the PNG into <project>/viz with a unique " +
      "filename and returns the filename to embed. On a render error this returns " +
      "the error text instead of an image; fix with edit_svg and re-render.",
    inputSchema: {
      type: "object",
      properties: {
        save_as: {
          type: "string",
          description:
            "Short kebab-case topic slug (e.g. 'number-line'). When set, the " +
            "rendered PNG is published to <project>/viz as viz-<slug>-<timestamp>.png " +
            "and the filename is returned. Omit for a preview-only render.",
        },
      },
    },
    async handler(params) {
      if (!session || !existsSync(session.bodyPath)) {
        return errorResult("render_svg: no source yet — call write_svg first.")
      }
      const { workDir, bodyPath } = session
      mkdirSync(workDir, { recursive: true })

      const outPath = join(workDir, `render-${Date.now()}.png`)
      const { ok, res } = await renderSvg(bodyPath, outPath, workDir)

      if (!ok) {
        const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n")
        const note = res.timedOut ? "SVG render timed out.\n\n" : ""
        return textResult(
          `${note}SVG render FAILED — no image produced. Fix the source with edit_svg and call render_svg again.\n\nError:\n${detail}`,
        )
      }

      const image = { type: "image", data: readFileSync(outPath).toString("base64"), mimeType: "image/png" }

      if (params.save_as) {
        const { filename, path } = publish(outPath, String(params.save_as))
        return {
          content: [
            {
              type: "text",
              text: `Published to viz/.\nfilename: ${filename}\npath: ${path}\n\nLOOK at the picture below to confirm the geometry is correct before returning it.`,
            },
            image,
          ],
        }
      }

      return {
        content: [
          {
            type: "text",
            text: "Preview render (not yet saved). LOOK: are coordinates, angles, directions, and proportions correct? Labels clear and unclipped? Fix with edit_svg, or re-render with `save_as` to publish.",
          },
          image,
        ],
      }
    },
  },
]
