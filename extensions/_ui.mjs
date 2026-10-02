/**
 * Shared UI plumbing for the pop-up-style tools (ask_user_question, quiz).
 *
 * In pi these tools drew their own TUI components with ctx.ui.custom(). Claude
 * Code has no extension UI API, but it does implement MCP *elicitation*: a
 * server can ask the client to show a native form dialog (single-select,
 * multi-select, text fields) and wait for the user's answer. Both tools build
 * their dialogs from that.
 */

// One elicitation dialog at a time. Claude Code can only show one dialog per
// prompt, so ALL pop-up-style tools (quiz, ask_user_question, ...) serialize
// against each other, not just against themselves — the same contract as the
// shared UI lock the pi extensions kept on globalThis. Both tools live in one
// server process here, so a module-level chain is enough.
let chain = Promise.resolve()

export function withUILock(fn) {
  const prev = chain
  let release
  chain = new Promise((r) => {
    release = r
  })
  return prev.then(fn).finally(() => release())
}

// A dialog waits on a human, so it must never time out on its own (the SDK's
// default request timeout is 60s). Claude Code does not auto-background an MCP
// call while one of its dialogs is open.
export const DIALOG_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000

/** `{ const, title }` entries for a titled single-select (oneOf) or multi-select (anyOf) field. */
export function choice(value, title) {
  return { const: value, title }
}

/** Display title for an option: numbered label, plus its description when given. */
export function optionTitle(index, option) {
  const base = `${index}. ${option.label}`
  return option.description ? `${base} — ${option.description}` : base
}

// Claude Code shows a dialog's message as at most 4 lines and cuts each line
// at the terminal width (no wrapping) — longer messages end in
// "… (+N more lines)". So pre-wrap to a width every terminal fits and put the
// most important line first.
const MESSAGE_WIDTH = 76

/** Word-wrap `text` (keeping its own line breaks) to lines of at most `width` columns. */
export function wrap(text, width = MESSAGE_WIDTH) {
  const out = []
  for (const paragraph of String(text ?? "").split("\n")) {
    let line = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    out.push(line)
  }
  return out
}

/** A dialog message: the given parts, each wrapped, blank lines dropped (they'd waste the 4-line budget). */
export function dialogMessage(...parts) {
  return parts
    .filter(Boolean)
    .flatMap((part) => wrap(part))
    .filter((line) => line.trim())
    .join("\n")
}

/** True when the error came from the call being aborted (turn interrupted). */
export function isAbort(error, signal) {
  return Boolean(signal?.aborted) || error?.name === "AbortError" || /abort/i.test(String(error?.message ?? ""))
}
