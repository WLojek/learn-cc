#!/usr/bin/env node
/**
 * safe-bash — the researcher subagent's `safe_bash` tool, as a PreToolUse hook.
 *
 * In pi, agents/researcher.md listed `safe_bash` (from pi-interactive-subagents):
 * the normal bash tool behind a regex denylist of dangerous commands. Claude
 * Code subagents can't get a renamed tool, but a subagent can carry its own
 * hooks — researcher.md runs this before every Bash call and it blocks the
 * same patterns, with the same message. Everything else (including network
 * access) is allowed, exactly like safe_bash; your normal Claude Code
 * permission mode still applies on top.
 */

import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

// From pi-interactive-subagents safe-bash.ts. The two rm patterns also catch a
// bare `~` (the original missed `rm -rf ~` at the end of a command) and $HOME.
export const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~|"?\$\{?HOME\b)/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~|"?\$\{?HOME\b)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  />\s*\/dev\/[sh]d[a-z]/,
  /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
  /\bchown\s+(-[a-zA-Z]+\s+)?root/,
  /\bcurl\s.*\|\s*(ba)?sh/,
  /\bwget\s.*\|\s*(ba)?sh/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  /\bkill\s+-9\s+1\b/,
  /\bkillall\b/,
]

/** The denylist match for `command`, or null when it's allowed. */
export function dangerousPattern(command) {
  const normalized = String(command ?? "").replace(/\\\n/g, " ")
  return DANGEROUS_PATTERNS.find((p) => p.test(normalized)) ?? null
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = {}
  try {
    input = JSON.parse(readFileSync(0, "utf-8"))
  } catch {}
  const pattern = input.tool_name === "Bash" ? dangerousPattern(input.tool_input?.command) : null
  if (pattern) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Command blocked by safe_bash: matches dangerous pattern ${pattern}`,
        },
      }),
    )
  }
  process.exit(0)
}
