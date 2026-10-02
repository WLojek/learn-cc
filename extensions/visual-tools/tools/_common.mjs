/**
 * Shared helpers for the visual-tools authoring loops (mermaid_tools.mjs,
 * svg_tools.mjs): a subprocess runner, a per-session managed source file, an
 * exact-match editor (Claude Code Edit semantics), publishing a chosen render
 * into <project>/viz with a unique filename, and the small MCP result helpers.
 *
 * Each tool file keeps its OWN session state (importing the helpers here),
 * so mermaid and svg never share a source file.
 */

import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"

// rsvg-convert lives under MacPorts (/opt/local/bin); magick/gs under
// /usr/local/bin; Homebrew under /opt/homebrew/bin. Augment PATH so the MCP
// server process (which may have inherited a thin PATH) still resolves them.
export const EXTRA_PATH = ["/opt/local/bin", "/usr/local/bin", "/opt/homebrew/bin"]

export const FILES_DIRNAME = "viz"

export const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]

export function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c
  return undefined
}

/** The learning project's root: where Claude Code was started. */
export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd()
}

/**
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function run(cmd, args, opts) {
  return new Promise((resolveRun) => {
    const augmentedPath = [...EXTRA_PATH, process.env.PATH ?? ""].join(":")
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}), PATH: augmentedPath },
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    // SIGTERM first: mmdc's puppeteer closes its headless Chrome on it, whereas
    // SIGKILL would orphan the browser. Force it only if it doesn't exit.
    let forceTimer
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    }, opts.timeoutMs)
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("error", (err) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      resolveRun({ code: null, stdout, stderr: stderr + String(err), timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      resolveRun({ code, stdout, stderr, timedOut })
    })
  })
}

// Transient session/preview files live in a private temp dir (NOT the vault),
// so only the PUBLISHED PNG ever lands inside the Obsidian vault (viz/).
// mkdtemp makes the dir unique and owner-only: a fixed path in a shared /tmp
// could be pre-planted with symlinks by another user on the same machine.
const workDirs = new Map()

/** This server process's private work dir for a group: created on first use, removed on exit. */
export function sessionDir(group) {
  if (!workDirs.has(group)) {
    const dir = mkdtempSync(join(tmpdir(), `claude-visual-tools-${group}-`))
    workDirs.set(group, dir)
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }))
  }
  return workDirs.get(group)
}

/**
 * Write the full source to the managed file, creating the session work dir.
 * @returns {{ workDir: string, bodyPath: string }}
 */
export function writeBody(group, bodyFileName, source) {
  const workDir = sessionDir(group)
  mkdirSync(workDir, { recursive: true })
  const bodyPath = join(workDir, bodyFileName)
  writeFileSync(bodyPath, source, "utf8")
  return { workDir, bodyPath }
}

/**
 * Exact-match single replacement on the current source, matching Claude Code's
 * built-in Edit: old_text must appear exactly once. Returns the updated content
 * and the match offset, or throws a precise error.
 */
export function applyEdit(current, oldText, newText) {
  if (oldText === "") throw new Error("`old_text` must be non-empty.")
  if (oldText === newText) throw new Error("`old_text` and `new_text` are identical.")
  const first = current.indexOf(oldText)
  if (first === -1) {
    throw new Error("`old_text` not found in the current source — match it exactly.")
  }
  const second = current.indexOf(oldText, first + 1)
  if (second !== -1) {
    let n = 0
    let i = current.indexOf(oldText)
    while (i !== -1) {
      n++
      i = current.indexOf(oldText, i + oldText.length)
    }
    throw new Error(`\`old_text\` appears ${n} times — add surrounding context to make it unique.`)
  }
  const updated = current.slice(0, first) + newText + current.slice(first + oldText.length)
  return { updated, index: first }
}

/** A small numbered window of `content` around char offset `index`. */
export function snippetAround(content, index, contextLines = 3) {
  const before = content.slice(0, index)
  const hitLine = before.split("\n").length - 1
  const lines = content.split("\n")
  const start = Math.max(0, hitLine - contextLines)
  const end = Math.min(lines.length - 1, hitLine + contextLines)
  const width = String(end + 1).length
  const out = []
  for (let i = start; i <= end; i++) out.push(`${String(i + 1).padStart(width)}  ${lines[i]}`)
  return out.join("\n")
}

/** Copy a rendered PNG into <project>/viz with a unique, slugified name. */
export function publish(pngPath, slug) {
  const filesDir = join(projectDir(), FILES_DIRNAME)
  mkdirSync(filesDir, { recursive: true })
  const clean =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "viz"
  const filename = `viz-${clean}-${Date.now()}.png`
  const dest = join(filesDir, filename)
  copyFileSync(pngPath, dest)
  return { filename, path: dest }
}

// ── MCP result helpers ───────────────────────────────────────────────────────

export function textResult(text) {
  return { content: [{ type: "text", text }] }
}

/** A tool-level error: the model sees the message and can fix and retry. */
export function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true }
}

export { basename, dirname, join, existsSync, mkdirSync, readFileSync, writeFileSync }
