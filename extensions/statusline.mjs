#!/usr/bin/env node
/**
 * Status line segment for md-log — the stand-in for pi's
 * ctx.ui.setStatus("md-log", "🗒 <file>").
 *
 * pi let an extension add one segment to its footer. Claude Code has a single
 * status line command, and this project's setting would replace yours — so
 * this script first runs YOUR status line (the `statusLine.command` from
 * ~/.claude/settings.json — or $CLAUDE_CONFIG_DIR — if any) with the same input, then appends
 * "🗒 <file>" while a markdown file is linked to the session.
 */

import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { loadState } from "./md-log.mjs"

// Set while running the user's command: if that command is (or calls) this
// script, the inner run prints nothing instead of recursing.
const NESTED = "LEARN_STATUSLINE_NESTED"
if (process.env[NESTED]) process.exit(0)

const raw = readFileSync(0, "utf-8")
let input = {}
try {
  input = JSON.parse(raw)
} catch {}

let base = ""
try {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
  const userCommand = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf-8"))?.statusLine?.command
  if (userCommand) {
    base = execSync(userCommand, {
      input: raw,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, [NESTED]: "1" },
    })
    base = base.replace(/\s+$/, "")
  }
} catch {
  // No user status line, or it failed — show just our segment.
}

const file = input.session_id ? loadState(input.session_id).file : null
const segment = file ? `🗒 ${basename(file)}` : ""
process.stdout.write([base, segment].filter(Boolean).join("  "))
