#!/usr/bin/env node
/**
 * md-log — mirror the session to a markdown file for comfortable reading.
 *
 * Designed for long teaching/learning sessions where the terminal is hard on
 * the eyes and markdown/math/code don't render. The linked .md file is meant
 * to be viewed rendered (e.g. in Obsidian), so assistant text with $...$ math,
 * code blocks, and markdown all render natively — no rendering work here.
 *
 * Captures only reading-relevant content:
 *   - user prompts
 *   - assistant text (lesson prose)
 *   - quiz / ask_user_question Q&A blocks
 * Other tools (bash, read, write, edit, ...) are omitted.
 *
 * Quiz/ask questions are written BEFORE the user answers (PreToolUse), so the
 * reader sees the question appear live, with the lesson text that led up to
 * it; the answer + feedback are appended once quiz_grade's result lands. The
 * question block NEVER contains the correct answer or explanation (the user
 * reads this file live; the quiz call doesn't even carry them).
 *
 * Commands (typed in the Claude Code prompt; handled here, never sent to the model):
 *   /md-log <filepath>  — Link a markdown file and backfill the session.
 *   /md-unlog           — Stop logging.
 *
 * Appends as the session goes. Two exceptions: /md-log fills the note with the
 * session so far (when there is one), and text that reaches the transcript after
 * its question was logged is slotted in above that question (see insertBefore).
 *
 * ── How it runs in Claude Code ──────────────────────────────────────────────
 * pi called this extension in-process on every event. Claude Code runs it as a
 * command hook (see settings.json), one short-lived process per event, with
 * the event JSON on stdin:
 *
 *   UserPromptSubmit     /md-log, /md-unlog (blocked, so the model never sees
 *                        them); otherwise logs the user's prompt
 *   UserPromptExpansion  a /skill invocation → "SKILL loaded: <name>" + args
 *   PreToolUse           quiz / ask_user_question → the question block, live
 *   Elicitation (async)  the dialog opens → the lesson text written before
 *                        the call, slotted in above the question
 *   PostToolUse (async)  → the answer block, once the result is on disk
 *   Stop (async)         → the assistant's text for the turn
 *
 * Assistant text and tool results are read from the session transcript
 * (JSONL) from a saved byte offset — Claude Code has no per-message event.
 * The link (file + offset) is stored per session in ../.md-log/<session>.json
 * (pi kept it in the session file), so it survives `claude --resume`.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { ASK_META_KEY } from "./ask-user-question.mjs"
import { QUIZ_META_KEY, displayedOptions } from "./quiz.mjs"

export const STATE_DIR =
  process.env.MD_LOG_STATE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".md-log")

const QUIZ_TOOL = /^mcp__.+__quiz$/
const QUIZ_GRADE_TOOL = /^mcp__.+__quiz_grade$/
const ASK_TOOL = /^mcp__.+__ask_user_question$/
const BUILTIN_ASK_TOOL = "AskUserQuestion"
const COMMANDS = new Set(["md-log", "md-unlog"])

const isQuiz = (name) => QUIZ_TOOL.test(name ?? "")
// The quiz's answer key and grade arrive in a second call (see quiz.mjs); its result carries the answer block.
const isQuizGrade = (name) => QUIZ_GRADE_TOOL.test(name ?? "")
const isQaTool = (name) => isQuiz(name) || isQuizGrade(name) || ASK_TOOL.test(name ?? "") || name === BUILTIN_ASK_TOOL

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── State ────────────────────────────────────────────────────────────────────
// { file: string | null, offset: number, qa: { [toolUseId]: { name, input } } }

export function statePath(sessionId) {
  return path.join(STATE_DIR, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`)
}

export function loadState(sessionId) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(sessionId), "utf-8"))
    return { file: s.file ?? null, offset: s.offset ?? 0, qa: s.qa ?? {} }
  } catch {
    return { file: null, offset: 0, qa: {} }
  }
}

function saveState(sessionId, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  // Write, then rename into place: hooks and the status line read this file
  // without the lock and must never see it half-written.
  const file = statePath(sessionId)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state), "utf-8")
  fs.renameSync(tmp, file)
}

// --- Serialization: hooks run as separate processes and can fire close
// together; one lock per session keeps state updates and appends ordered. ---

async function withLock(sessionId, fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const lockDir = statePath(sessionId) + ".lock"
  const deadline = Date.now() + 10_000
  let acquired = false
  while (!acquired) {
    try {
      fs.mkdirSync(lockDir)
      acquired = true
      try {
        fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid))
      } catch {}
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      if (lockIsStale(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true })
      else if (Date.now() > deadline) break // never hang Claude Code on a stuck lock
      else await sleep(20)
    }
  }
  try {
    return await fn()
  } finally {
    if (acquired) fs.rmSync(lockDir, { recursive: true, force: true })
  }
}

// Locks are held for milliseconds. One left by a hook that was killed (Claude
// Code exiting mid-hook) is stale as soon as its holder is gone, or after a few
// seconds when the holder can't be told.
function lockIsStale(lockDir) {
  let age
  try {
    age = Date.now() - fs.statSync(lockDir).mtimeMs
  } catch {
    return false // released meanwhile
  }
  let pid = 0
  try {
    pid = Number(fs.readFileSync(path.join(lockDir, "pid"), "utf-8"))
  } catch {}
  if (pid > 0 && !isAlive(pid)) return true
  return age > (pid > 0 ? 30_000 : 5_000)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}

function appendToFile(file, text) {
  // A note renamed or deleted in Obsidian is not re-created at its old path.
  if (!file || !fs.existsSync(file)) return
  try {
    const current = fs.readFileSync(file, "utf-8")
    const prefix = current.trim().length > 0 ? "\n\n" : ""
    fs.writeFileSync(file, current + prefix + text + "\n", "utf-8")
  } catch {
    // File may have been deleted externally; ignore.
  }
}

// Claude Code writes a turn's assistant message to the transcript only once
// its tool calls have finished — so the text that leads up to a quiz is not on
// disk yet when the question is logged (live, before the user answers). When
// that text shows up later, it is slotted in right above its question block,
// found by its exact text, so the finished log reads in order.
function insertBefore(file, anchor, text) {
  if (!file) return
  try {
    const current = fs.readFileSync(file, "utf-8")
    const at = current.lastIndexOf(anchor)
    if (at < 0) return appendToFile(file, text) // the reader edited it away; don't lose the text
    fs.writeFileSync(file, current.slice(0, at) + text + "\n\n\n" + current.slice(at), "utf-8")
  } catch {
    // File may have been deleted externally; ignore.
  }
}

// ── Transcript ───────────────────────────────────────────────────────────────

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** The raw bytes of `file` from `offset` on, and where they start (clamped if the file shrank). */
function readFrom(file, offset) {
  let fd
  try {
    fd = fs.openSync(file, "r")
    const size = fs.fstatSync(fd).size
    const start = Math.min(offset, size) // file replaced/truncated: don't replay it
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return { buf, start }
  } catch {
    return { buf: Buffer.alloc(0), start: offset }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Parse the complete JSONL lines of `file` from byte `offset`; returns the entries and the new offset. */
export function readTranscript(file, offset = 0) {
  const { buf, start } = readFrom(file, offset)
  const lastNewline = buf.lastIndexOf(0x0a)
  if (lastNewline < 0) return { entries: [], end: start }
  const chunk = buf.subarray(0, lastNewline + 1).toString("utf-8")
  const entries = []
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // Torn or foreign line; skip.
    }
  }
  return { entries, end: start + lastNewline + 1 }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(40)
  }
}

/** The raw transcript text from byte `offset` on (cheap to poll, even for a long session). */
function transcriptTail(file, offset) {
  return readFrom(file, offset).buf.toString("utf-8")
}

// ── Formatting ───────────────────────────────────────────────────────────────

function callout(type, title, bodyLines) {
  const lines = [`> [!${type}] ${title}`]
  for (const line of bodyLines) {
    lines.push(line.length === 0 ? ">" : `> ${line}`)
  }
  return lines.join("\n")
}

function userBlock(text) {
  return `> [!quote] YOU\n\n${text}`
}

// Skill invocations (`/teach how TCP works`) load the whole SKILL.md as
// system-injected context. Log a compact note that the skill was loaded plus
// the user's own words, so the log keeps the signal without the noise.
function skillBlock(name, args) {
  const note = `> [!note] SKILL loaded: ${name}`
  return userBlock(args.trim() ? `${note}\n\n${args.trim()}` : note)
}

function assistantBlock(text) {
  return `> [!abstract] CLAUDE\n\n${text}`
}

function optionsList(options) {
  return options.map((o, i) => `${i + 1}. ${o.label}`)
}

function questionCallout(label, question, context, options) {
  const body = []
  for (const line of String(question).split("\n")) body.push(line)
  if (context) {
    body.push("")
    for (const line of context.split("\n")) body.push(line)
  }
  if (options.length > 0) {
    body.push("")
    body.push(...optionsList(options))
  }
  return callout("question", label, body)
}

function answerCalloutQuiz(details) {
  const status = details?.status
  if (status === "cancelled") {
    return callout("warning", "Quiz — cancelled", ["(user skipped)"])
  }
  if (status === "unavailable") {
    return callout("warning", "Quiz — unavailable", [details?.message || ""])
  }
  // "I don't know" is neither correct nor incorrect — it's a distinct signal,
  // so it never renders as a red ✗.
  const dontKnow = details?.dontKnow === true
  const correct = details?.correct === true
  const type = dontKnow ? "question" : correct ? "success" : "failure"
  const title = dontKnow ? "Quiz — I don't know" : correct ? "Quiz — correct ✓" : "Quiz — incorrect ✗"
  const body = []

  if (dontKnow) {
    body.push("Your answer: I don't know")
  } else {
    const answers = details?.answers || []
    const sel = answers.map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)"
    body.push(`Your answer: ${sel}`)
  }

  const correctIndices = details?.correctIndices || []
  body.push(`Correct answer: ${correctIndices.map((i) => `${i}`).join(", ")}`)

  // Optional free-text note the user typed in the always-present note field.
  // Only present (in details) when non-empty, so no guard for empty strings.
  if (details?.note) {
    body.push("")
    const noteLines = String(details.note).split("\n")
    body.push(`Note: ${noteLines[0]}`)
    for (let i = 1; i < noteLines.length; i++) body.push(noteLines[i])
  }

  if (details?.explanation) {
    body.push("")
    for (const line of String(details.explanation).split("\n")) body.push(line)
  }
  return callout(type, title, body)
}

function answerCalloutAsk(details) {
  const status = details?.status
  if (status === "cancelled") {
    return callout("warning", "Question — cancelled", ["(user skipped)"])
  }
  if (status === "unavailable") {
    return callout("warning", "Question — unavailable", [details?.message || ""])
  }
  const answers = details?.answers || []
  const body = answers.map((a) => {
    if (a.type === "other") return `Other: ${a.label}`
    if (a.type === "text") return a.label
    return `${a.index}. ${a.label}`
  })
  if (body.length === 0) body.push("(no answer)")
  return callout("example", "Answer", body)
}

// Claude Code's own AskUserQuestion (up to 4 questions per call). Not part of
// the pi system — logged too in case the model reaches for it.
function builtinQuestionCallouts(input) {
  return (input?.questions || []).map((q) => questionCallout("Question", q.question || "", undefined, q.options || []))
}

function builtinAnswerCallouts(input, toolUseResult, isError) {
  if (isError || !toolUseResult?.answers) return [callout("warning", "Question — cancelled", ["(user skipped)"])]
  return (input?.questions || []).map((q) => {
    const body = [String(toolUseResult.answers[q.question] ?? "(no answer)")]
    const notes = toolUseResult.annotations?.[q.question]?.notes
    if (notes) body.push("", `Note: ${notes}`)
    return callout("example", "Answer", body)
  })
}

// Turns Claude Code injects as user prompts: background task notifications,
// subagent/teammate messages, wakeups, local command and bash-mode output.
// Recognised by their markup: since Claude Code 2.1.287 the UserPromptSubmit
// input no longer says where a prompt came from.
const INJECTED_PROMPT =
  /^<(local-command-|bash-|task-notification|agent-message|teammate-message|cross-session-message|channel|wake|system-reminder)\b/

// What Claude Code returns in place of the result when it moves a long MCP
// call to the background (settings.json turns that off for this project). The
// real answer arrives later in a task notification, so there's nothing to log.
const BACKGROUNDED_RESULT = /^MCP tool "[^"]*" (is still running after|was moved to the background)/

const resultText = (block) =>
  typeof block.content === "string"
    ? block.content
    : (block.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n")

/** Answer callout(s) for a QA tool_result entry. */
function answerBlocks(toolUse, entry, block) {
  const meta = entry.mcpMeta?._meta
  if (!meta && BACKGROUNDED_RESULT.test(resultText(block))) return []
  if (isQuiz(toolUse.name) || isQuizGrade(toolUse.name)) {
    const details = meta?.[QUIZ_META_KEY]
    // quiz → "awaiting_grade" (the answer comes with quiz_grade); quiz_grade → "invalid" key (retried) — nothing to log yet.
    if (details?.status === "awaiting_grade" || details?.status === "invalid") return []
    if (!details && isQuizGrade(toolUse.name)) return []
    return [details ? answerCalloutQuiz(details) : callout("example", "Quiz — result", [resultText(block)])]
  }
  if (toolUse.name === BUILTIN_ASK_TOOL) {
    return builtinAnswerCallouts(toolUse.input, entry.toolUseResult, block.is_error)
  }
  return [meta?.[ASK_META_KEY] ? answerCalloutAsk(meta[ASK_META_KEY]) : callout("example", "Answer", [resultText(block)])]
}

/** The live question callout(s), written before the user answers. */
function questionBlocks(toolName, input, toolUseId) {
  if (isQuizGrade(toolName)) return []
  if (toolName === BUILTIN_ASK_TOOL) return builtinQuestionCallouts(input)
  const question = input?.question || ""
  const context = String(input?.details ?? "").trim() || undefined
  if (isQuiz(toolName)) {
    // The quiz shuffles its options with a seed derived from the tool_use id;
    // re-derive the same order so the logged question matches the screen.
    let options
    try {
      options = displayedOptions(input?.options, { shuffle: input?.shuffle, seed: toolUseId })
    } catch {
      return [] // invalid options: the quiz never shows a question (its result logs why)
    }
    if (options.length === 0) return []
    return [questionCallout("Quiz", question, context, options)]
  }
  const options = (Array.isArray(input?.options) ? input.options : []).filter((o) => String(o?.label ?? "").trim())
  return [questionCallout("Question", question, context, options)]
}

// ── Live mirroring ───────────────────────────────────────────────────────────

/**
 * Turn transcript entries (in file order) into log blocks: one CLAUDE block
 * per assistant message's text, plus answer blocks for quiz/ask results. User
 * prompts and questions are written by their own hooks, so they're not here.
 * Returns `{ text, before? }` items: `before` is a question block already in
 * the log that the text must go above (see insertBefore).
 * Mutates `state.qa` (pending quiz/ask calls → their args + logged question).
 */
export function liveBlocks(state, entries) {
  const blocks = []
  let segmentStart = 0 // blocks from here on haven't been tied to a question yet
  let pending = null
  const endPending = () => {
    if (pending?.parts.length) blocks.push({ text: assistantBlock(pending.parts.join("\n\n")) })
    pending = null
  }
  for (const entry of entries) {
    if (entry.isSidechain) continue
    if (entry.type === "assistant" && !entry.isApiErrorMessage) {
      const msg = entry.message || {}
      for (const c of msg.content || []) {
        if (c.type === "text" && c.text?.trim()) {
          if (!pending || pending.id !== msg.id) {
            endPending()
            pending = { id: msg.id, parts: [] }
          }
          pending.parts.push(c.text.trim())
        } else if (c.type === "tool_use" && isQaTool(c.name)) {
          const logged = state.qa[c.id]?.question
          if (logged) {
            // Everything since the last question belongs above this call's (already logged) question.
            endPending()
            for (const block of blocks.slice(segmentStart)) block.before = logged
            segmentStart = blocks.length
          }
          state.qa[c.id] = { name: c.name, input: c.input }
        }
      }
      continue
    }
    if (entry.type === "user" && Array.isArray(entry.message?.content)) {
      for (const c of entry.message.content) {
        if (c.type !== "tool_result" || !state.qa[c.tool_use_id]) continue
        endPending()
        for (const text of answerBlocks(state.qa[c.tool_use_id], entry, c)) blocks.push({ text })
        delete state.qa[c.tool_use_id]
      }
    }
  }
  endPending()
  return blocks
}

/** Append everything new in the transcript since the saved offset. Call under the lock. */
function flush(state, transcriptPath) {
  const { entries, end } = readTranscript(transcriptPath, state.offset)
  state.offset = end
  for (const block of liveBlocks(state, entries)) {
    if (block.before) insertBefore(state.file, block.before, block.text)
    else appendToFile(state.file, block.text)
  }
}

// ── Backfill ─────────────────────────────────────────────────────────────────

function userText(entry) {
  const content = entry.message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content) || content.some((c) => c.type === "tool_result")) return ""
  return content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
}

const isSkillBody = (entry) => entry?.isMeta && /^Base directory for this skill:/.test(userText(entry).trim())

/** Is the slash command at chain[i] followed by an injected skill body (before the next real message)? */
function loadsSkill(chain, i) {
  for (let j = i + 1; j < Math.min(chain.length, i + 6); j++) {
    if (isSkillBody(chain[j])) return true
    if (chain[j].type === "assistant" || (chain[j].type === "user" && !chain[j].isMeta)) return false
  }
  return false
}

/** The active conversation: walk parent links from the newest entry back to the root (across compactions). */
function activeChain(entries) {
  const byId = new Map()
  for (const e of entries) if (e.uuid) byId.set(e.uuid, e)
  let leaf = null
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.uuid && !e.isSidechain && ["user", "assistant", "system", "attachment"].includes(e.type)) {
      leaf = e
      break
    }
  }
  const chain = []
  const seen = new Set()
  let cur = leaf
  while (cur && cur.uuid && !seen.has(cur.uuid)) {
    seen.add(cur.uuid)
    chain.push(cur)
    const parent = cur.parentUuid ?? (cur.subtype === "compact_boundary" ? cur.logicalParentUuid : null)
    cur = parent ? byId.get(parent) : null
  }
  return chain.reverse()
}

/** Rebuild the whole log for the active branch of a transcript. Returns { blocks, count }. */
export function backfillBlocks(entries) {
  // Parallel tool calls branch the parent chain (each result hangs off its own
  // tool_use), so results are looked up by id across the whole file.
  const results = new Map()
  for (const e of entries) {
    if (e.type !== "user" || !Array.isArray(e.message?.content)) continue
    for (const c of e.message.content) if (c.type === "tool_result") results.set(c.tool_use_id, { entry: e, block: c })
  }

  const chain = activeChain(entries)
  const blocks = []
  const countedMessages = new Set()
  let pending = null
  const endPending = () => {
    if (pending?.parts.length) blocks.push(assistantBlock(pending.parts.join("\n\n")))
    pending = null
  }

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i]
    if (entry.isSidechain) continue

    if (entry.type === "user") {
      if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) continue
      const text = userText(entry).trim()
      if (!text) continue
      countedMessages.add(entry.uuid)
      const command = /<command-name>\/?([^<]+)<\/command-name>/.exec(text)
      if (command) {
        // Skills/custom commands are followed by their injected body; built-ins (/model, /clear...) aren't.
        const name = command[1].trim()
        if (COMMANDS.has(name) || !loadsSkill(chain, i)) continue
        endPending()
        blocks.push(skillBlock(name, /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ""))
        continue
      }
      if (INJECTED_PROMPT.test(text) || text.startsWith("[Request interrupted")) continue
      endPending()
      blocks.push(userBlock(text))
      continue
    }

    if (entry.type === "assistant" && !entry.isApiErrorMessage) {
      const msg = entry.message || {}
      if (msg.id) countedMessages.add(msg.id)
      for (const c of msg.content || []) {
        if (c.type === "text" && c.text?.trim()) {
          if (!pending || pending.id !== msg.id) {
            endPending()
            pending = { id: msg.id, parts: [] }
          }
          pending.parts.push(c.text.trim())
          continue
        }
        if (c.type !== "tool_use" || !isQaTool(c.name)) continue
        const result = results.get(c.id)
        if (!result) continue
        endPending()
        // Question block. For quiz, use the result's `options` — the TRUE
        // post-shuffle display order the user actually saw.
        const details = result.entry.mcpMeta?._meta?.[QUIZ_META_KEY]
        if (isQuiz(c.name) && details?.options?.length) {
          const context = String(c.input?.details ?? "").trim() || undefined
          blocks.push(questionCallout("Quiz", c.input?.question || "", context, details.options))
        } else {
          blocks.push(...questionBlocks(c.name, c.input, c.id))
        }
        blocks.push(...answerBlocks({ name: c.name, input: c.input }, result.entry, result.block))
      }
    }
  }
  endPending()
  return { blocks, count: countedMessages.size }
}

// ── Commands ─────────────────────────────────────────────────────────────────

function linkCommand(input, args) {
  const filepath = args.trim()
  if (!filepath) return "Usage: /md-log <filepath>"

  // Relative to the project (pi: the session's cwd) — not to wherever the agent last `cd`-ed.
  const base = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
  const resolved = path.isAbsolute(filepath) ? filepath : path.resolve(base, filepath)

  // The file must already exist — /md-log links into an existing note,
  // it never creates one. This avoids silently scattering new files
  // (and parent directories) around the vault from a typo'd path.
  if (!fs.existsSync(resolved)) {
    return `File does not exist: ${resolved}\n/md-log links an existing note. Create it first (e.g. type: ! touch ${filepath}), then run /md-log again.`
  }
  if (!fs.statSync(resolved).isFile()) return `Not a file: ${resolved}`

  // Backfill the active branch.
  const { entries, end } = readTranscript(input.transcript_path, 0)
  const { blocks, count } = backfillBlocks(entries)
  if (blocks.length > 0) {
    try {
      fs.writeFileSync(resolved, blocks.join("\n\n") + "\n", "utf-8")
    } catch {
      // ignore
    }
  }
  saveState(input.session_id, { file: resolved, offset: end, qa: {} })
  return `Linked: ${resolved} (${count} entries backfilled)`
}

function unlinkCommand(input) {
  const state = loadState(input.session_id)
  if (!state.file) return "No file linked"
  const name = path.basename(state.file)
  saveState(input.session_id, { ...state, file: null })
  return `Unlinked: ${name}`
}

// ── Event handlers ───────────────────────────────────────────────────────────

/** Returns the hook's stdout (JSON), or "" to let the event through untouched. */
export async function handle(input) {
  if (input.agent_id) return "" // a subagent's own events: pi's md-log only ever saw the main session
  const sessionId = input.session_id
  const event = input.hook_event_name

  if (event === "UserPromptSubmit") {
    const prompt = String(input.prompt ?? "").trim()
    const command = /^\/(md-log|md-unlog)(?:\s+([\s\S]*))?$/.exec(prompt)
    if (command) {
      let message
      try {
        message = await withLock(sessionId, () =>
          command[1] === "md-log" ? linkCommand(input, command[2] ?? "") : unlinkCommand(input),
        )
      } catch (e) {
        message = `md-log failed: ${e?.message ?? e}`
      }
      // "block" = handled here: the prompt is erased and never reaches the model; the reason is shown to the user.
      return JSON.stringify({ decision: "block", reason: message })
    }
    // Slash commands are logged by UserPromptExpansion (skills) or not at all
    // (built-ins); a path like "/usr/bin/env is broken?" is an ordinary prompt.
    if (/^\/[\w:.-]+(\s|$)/.test(prompt) || prompt.startsWith("!")) return ""
    // Only what the user typed — not task notifications, wakeups, or other injected turns.
    if (input.source && input.source !== "user" && input.source !== "sdk") return ""
    if (INJECTED_PROMPT.test(prompt)) return ""
    if (!prompt || !loadState(sessionId).file) return ""
    await withLock(sessionId, () => {
      const state = loadState(sessionId)
      if (!state.file) return
      flush(state, input.transcript_path) // anything still pending from the previous turn goes first
      appendToFile(state.file, userBlock(prompt))
      saveState(sessionId, state)
    })
    return ""
  }

  if (event === "UserPromptExpansion") {
    if (input.expansion_type !== "slash_command" || COMMANDS.has(input.command_name)) return ""
    if (!loadState(sessionId).file) return ""
    await withLock(sessionId, () => {
      const state = loadState(sessionId)
      if (!state.file) return
      flush(state, input.transcript_path)
      appendToFile(state.file, skillBlock(input.command_name, String(input.command_args ?? "")))
      saveState(sessionId, state)
    })
    return ""
  }

  if (!loadState(sessionId).file) return ""

  if (event === "PreToolUse") {
    if (!isQaTool(input.tool_name) || isQuizGrade(input.tool_name)) return ""
    // Synchronous (a few ms), so the question is always logged before its
    // answer. Whatever of the turn is already on disk goes first; text that
    // reaches the transcript only after the call finishes is slotted in above
    // this question later (see insertBefore).
    await withLock(sessionId, () => {
      const state = loadState(sessionId)
      if (!state.file) return
      flush(state, input.transcript_path)
      const blocks = questionBlocks(input.tool_name, input.tool_input, input.tool_use_id)
      state.qa[input.tool_use_id] = { name: input.tool_name, input: input.tool_input, question: blocks[0] }
      for (const block of blocks) appendToFile(state.file, block)
      saveState(sessionId, state)
    })
    return ""
  }

  if (event === "Elicitation") {
    // A quiz/ask dialog is opening. Its tool reported progress first, which
    // makes Claude Code write the response so far — the lesson text and the
    // call — to the transcript (see _mcp.mjs saveTranscript). Wait for that
    // write, then flush: the text lands above the already-logged question
    // while the dialog is still open. Runs async: the dialog isn't held up.
    const waiting = Object.entries(loadState(sessionId).qa)
      .filter(([, qa]) => qa.question)
      .map(([id]) => id)
    if (waiting.length === 0) return ""
    const from = loadState(sessionId).offset
    await waitFor(() => {
      const tail = transcriptTail(input.transcript_path, from)
      return waiting.every((id) => tail.includes(id))
    }, 5000)
    await withLock(sessionId, () => {
      const state = loadState(sessionId)
      if (!state.file) return
      flush(state, input.transcript_path)
      saveState(sessionId, state)
    })
    return ""
  }

  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    if (!isQaTool(input.tool_name)) return ""
    // The result is written to the transcript right after this hook; the hook
    // runs async, so wait for it, then flush (which writes the answer block).
    const marker = new RegExp(`"tool_use_id":\\s*"${input.tool_use_id}"`)
    const from = loadState(sessionId).offset
    await waitFor(() => marker.test(transcriptTail(input.transcript_path, from)), 15_000)
    await withLock(sessionId, () => {
      const state = loadState(sessionId)
      if (!state.file) return
      flush(state, input.transcript_path)
      saveState(sessionId, state)
    })
    return ""
  }

  if (event === "Stop") {
    // Wait for the turn's last message to reach the transcript (the hook runs async).
    const last = String(input.last_assistant_message ?? "").trim().slice(0, 60)
    if (last) {
      const from = loadState(sessionId).offset
      await waitFor(() => {
        const { entries } = readTranscript(input.transcript_path, from)
        return entries.some(
          (e) => e.type === "assistant" && (e.message?.content || []).some((c) => c.type === "text" && c.text?.includes(last)),
        )
      }, 5000)
    }
    await withLock(sessionId, () => {
      const state = loadState(sessionId)
      if (!state.file) return
      flush(state, input.transcript_path)
      saveState(sessionId, state)
    })
    return ""
  }

  return ""
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf-8")
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = await handle(JSON.parse(await readStdin()))
    if (out) process.stdout.write(out)
  } catch (e) {
    // Never break the session over logging; report on stderr (visible in --debug).
    process.stderr.write(`md-log: ${e?.stack ?? e}\n`)
  }
  process.exit(0)
}
