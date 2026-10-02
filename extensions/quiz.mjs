import { choice, dialogMessage, isAbort, optionTitle, withUILock } from "./_ui.mjs"

// ────────────────────────────────────────────────────────────────────────────
// quiz — a GRADED sibling of ask_user_question.
//
// Where ask_user_question collects a preference/decision with no notion of
// right or wrong, `quiz` poses a question that HAS a correct answer, grades the
// user's selection instantly, and shows tight feedback (✓/✗ + the correct
// answer + an optional explanation) to both the user and the agent.
//
// It is intentionally options-only: single-select or multi-select. There is no
// free-text mode and no "Other" option, because a free-text answer can't be
// graded against a correct index.
//
// ── Sealed answer key: two calls ────────────────────────────────────────────
// pi's quiz took the answer key in the same call and simply never rendered it.
// Claude Code shows every tool argument in its transcript view (Ctrl+O), so a
// key in the question call would be readable before the learner answers. So:
//
//   quiz        question + options only → the answer dialog. The learner's
//               choice is kept HERE, hidden from the model too.
//   quiz_grade  correctAnswer + explanation → grades the waiting answer, shows
//               the feedback dialog, returns the pi result text.
//
// The key reaches the screen only after the learner has answered, and the
// model commits it without knowing what they picked — so it can't bend the
// key to their answer (pi's single call guaranteed the same).
//
// The pop-ups are Claude Code's native MCP elicitation dialogs (see _ui.mjs):
// one form to answer (options + "I don't know" + an optional note), then one
// read-only form with the graded feedback (verdict + explanation; a dialog has
// room for only 4 message lines, so the per-option ✓/✗ list of the pi popup
// lives in the md-log and the tool result instead).
// ────────────────────────────────────────────────────────────────────────────

// The always-present "I don't know" choice. It is NOT a real option: it never
// participates in shuffling, has no correct-answer value, and produces a
// distinct signal (dontKnow) rather than a right/wrong grade — so an honest
// "I don't know" is never confused with a lucky or unlucky guess.
const DONT_KNOW_VALUE = "dont_know"
const DONT_KNOW_LABEL = "I don't know"

/** `_meta` key on the tool result that carries the structured details (read by md-log; never sent to the model). */
export const QUIZ_META_KEY = "learn/quiz"

const OptionSchema = {
  type: "object",
  properties: {
    label: { type: "string", description: "Display label for the answer option." },
    value: {
      type: "string",
      description: "Optional machine-readable value returned for the option. Defaults to the label.",
    },
    description: { type: "string", description: "Optional extra detail shown next to the option." },
  },
  required: ["label"],
}

// No correctAnswer / explanation here: they go to quiz_grade (see above).
const QuizParams = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The single quiz question to ask. Ask exactly one question per tool call.",
    },
    details: { type: "string", description: "Optional extra context or instructions shown under the question." },
    options: {
      type: "array",
      items: OptionSchema,
      minItems: 2,
      description:
        "The answer options (2 or more). Options only; there is no free-text mode. Give each option a stable `value`; after the user answers you reference the correct one by that value in quiz_grade's correctAnswer. " +
        "Provide ONLY the real, gradable options: an 'I don't know' choice is ALWAYS added automatically, so never add your own uncertainty/opt-out option like 'I don't know', 'I'm not sure', or 'Not sure'; a manual one would be redundant or gradable-as-wrong. " +
        "Treat each wrong answer (distractor) as a diagnostic probe, not just filler: make it a specific, believable mistake the user might actually hold (a common misconception, or an adjacent/easily-confused concept), so that WHICH wrong answer they pick reveals WHICH nuance of their understanding is off, and tells you exactly which gap to teach into next (and what the explanation should address). " +
        "Guardrail: every distractor must be unambiguously wrong on the intended reading: tempting, but a real error, not a defensible alternative. Don't drift into trick questions. " +
        "Anti-guessing hygiene: don't let the correct answer stand out by form (longest, most precise, most hedged, or the only one in the right format). Keep options similar in length, specificity, and phrasing so it can't be picked from shape alone, and don't leak it through formatting.",
    },
    multiSelect: {
      type: "boolean",
      description:
        "Set to true only when more than one option is correct and the user must select all of them. Multi-select is graded as an exact-set match: the user is correct only if they select every correct option and no incorrect ones.",
    },
    shuffle: {
      type: "boolean",
      description:
        "Defaults to true: options are randomly reordered before display so the correct answer isn't always in the same position, so don't worry about which position you list it in. Set to false only when option order is meaningful (e.g. ordered numeric values, or an 'All/None of the above' option that must stay last).",
    },
  },
  required: ["question", "options"],
  additionalProperties: false,
}

const QuizGradeParams = {
  type: "object",
  properties: {
    correctAnswer: {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      description:
        'REQUIRED. The correct answer as the option value(s): the `value` field of the option you intend. Single-select: a single string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]); the user is only correct if their selection matches this set exactly. Always pass the value, not a position number; this is self-checking and prevents miscounting. A value that matches no option is rejected (the answer stays waiting; call quiz_grade again with a valid value).',
    },
    explanation: {
      type: "string",
      description:
        "REQUIRED. Always say why the correct answer is correct. Revealed AFTER the user answers (shown whether they got it right or wrong); use it to reinforce why the correct answer is correct.",
    },
  },
  required: ["correctAnswer", "explanation"],
}

function normalizeOptions(options) {
  const seen = new Set()
  return (options || [])
    .map((option) => ({
      label: String(option?.label ?? "").trim(),
      value: String(option?.value ?? "").trim() || String(option?.label ?? "").trim(),
      description: String(option?.description ?? "").trim() || undefined,
    }))
    .filter((option) => {
      if (option.label.length === 0) return false
      if (seen.has(option.value)) throw new Error(`duplicate option value "${option.value}"`)
      seen.add(option.value)
      return true
    })
}

// Seeded PRNG (FNV-1a hash → mulberry32). The seed is the tool_use id Claude
// Code sends with every MCP call, so the order is random per question yet
// reproducible: md-log re-derives the exact on-screen order from the same id
// to log the question BEFORE the user answers (pi used an onUpdate event).
function seededRandom(seed) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Fisher-Yates shuffle over a copy. Safe to reorder for display because
// correctAnswer is keyed by value, not position — indices are resolved AFTER
// shuffling, so grading always matches what the user actually sees.
function shuffleOptions(options, seed) {
  const random = seed ? seededRandom(seed) : Math.random
  const out = [...options]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * The options exactly as the user sees them: normalized, then shuffled (unless
 * `shuffle: false`) with the given seed. Shared with md-log. Throws on
 * duplicate option values.
 */
export function displayedOptions(rawOptions, { shuffle, seed } = {}) {
  const options = normalizeOptions(rawOptions)
  return shuffle === false ? options : shuffleOptions(options, seed)
}

// Resolve author-supplied option value(s) to 1-based indices. Keying by value
// (not position) makes the correct answer self-documenting: the author writes
// `correctAnswer: "mercury"` and a typo becomes a hard error instead of a
// silent wrong grade.
// The model sometimes delivers a multi-select `correctAnswer` array as a
// JSON-stringified string (e.g. '["a", "b"]') instead of a real array, because
// the schema union lists String first. Detect that case and parse it back into
// an array so grading resolves against real option values. A plain single value
// is wrapped as-is.
function coerceCorrectAnswer(correctAnswer) {
  if (Array.isArray(correctAnswer)) return correctAnswer
  const trimmed = String(correctAnswer).trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map((v) => String(v))
    } catch {
      // Not valid JSON — fall through and treat as a single literal value.
    }
  }
  return [String(correctAnswer)]
}

export function resolveCorrect(correctAnswer, options) {
  if (correctAnswer === undefined || correctAnswer === null) return { indices: [], error: "correctAnswer is required" }
  const byValue = new Map(options.map((o, i) => [o.value, i + 1]))
  // A string that is itself an option value wins over JSON parsing, so an
  // option that looks like a list (e.g. "[1, 2, 3]" in a programming quiz) works.
  const exact = typeof correctAnswer === "string" && byValue.has(correctAnswer.trim())
  const arr = exact ? [correctAnswer.trim()] : coerceCorrectAnswer(correctAnswer)
  if (arr.length === 0) return { indices: [], error: "correctAnswer is required" }
  const indices = []
  for (const raw of arr) {
    const v = typeof raw === "string" ? raw.trim() : raw
    const idx = byValue.get(v)
    if (idx === undefined) {
      const known = options.map((o) => `"${o.value}"`).join(", ")
      return { indices: [], error: `correctAnswer "${v}" does not match any option value (${known})` }
    }
    indices.push(idx)
  }
  return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) }
}

function isCorrect(selectedIndices, correctIndices) {
  if (selectedIndices.length !== correctIndices.length) return false
  const a = [...selectedIndices].sort((x, y) => x - y)
  const b = [...correctIndices].sort((x, y) => x - y)
  return a.every((v, i) => v === b[i])
}

function sortAnswers(answers) {
  return [...answers].sort((a, b) => a.index - b.index)
}

function formatOptionRef(options, index) {
  const opt = options.find((_o, i) => i + 1 === index)
  return `${index}. ${opt ? opt.label : "(unknown)"}`
}

// ── results ─────────────────────────────────────────────────────────────────
// The model reads `content` (same text as the pi tool). The structured details
// ride in `_meta`, which Claude Code stores in the transcript but never sends
// to the model — md-log reads them from there.

function result(text, details) {
  return { content: [{ type: "text", text }], _meta: { [QUIZ_META_KEY]: details } }
}

function cancelledResult(question, mode, context) {
  const message = "User cancelled the quiz"
  return result(message, { status: "cancelled", question, context, mode, answers: [], correctIndices: [], message })
}

function unavailableResult(question, mode, message, context) {
  return result(message, { status: "unavailable", question, context, mode, answers: [], correctIndices: [], message })
}

function buildResult(question, context, mode, options, response, correctIndices, explanation) {
  const { dontKnow, note, answers } = response
  const selectedIndices = answers.map((a) => a.index)
  // "I don't know" is never counted as correct — it's a distinct outcome.
  const correct = dontKnow ? false : isCorrect(selectedIndices, correctIndices)
  const correctStr = correctIndices.map((i) => formatOptionRef(options, i)).join(", ")
  const displayed = options.map((o, i) => ({ index: i + 1, label: o.label }))

  let text
  if (dontKnow) {
    // Make the signal explicit for the agent: the user did NOT guess, so this
    // is a genuine knowledge gap, not a wrong answer to correct against.
    text = `User selected "I don't know" — they did not attempt an answer (a genuine knowledge gap, not a wrong guess).`
    text += `\nCorrect: ${correctStr}`
    if (note) text += `\nUser's note: ${note}`
  } else {
    const verdict = correct ? "correctly" : "incorrectly"
    const selectedStr = answers.map((a) => `${a.index}. ${a.label}`).join(", ")
    text = `User answered ${verdict}.\nSelected: ${selectedStr}\nCorrect: ${correctStr}`
    if (note) text += `\nUser's note: ${note}`
  }
  if (explanation) text += `\nExplanation: ${explanation}`

  return result(text, {
    status: "answered",
    question,
    context,
    mode,
    answers,
    correctIndices,
    options: displayed,
    correct,
    dontKnow,
    ...(note ? { note } : {}),
    explanation,
  })
}

// ── dialogs ─────────────────────────────────────────────────────────────────

/**
 * The answer form: the options in display order, the "I don't know" row last,
 * and the always-present optional note field. Returns null when the user
 * cancels (Esc).
 */
async function askQuiz(ctx, question, context, options, multi) {
  const choices = [
    ...options.map((option, i) => choice(String(i + 1), optionTitle(i + 1, option))),
    choice(DONT_KNOW_VALUE, DONT_KNOW_LABEL),
  ]
  const note = {
    type: "string",
    title: "Note (optional)",
    description: "Anything you want to add: what you were thinking or unsure about.",
  }

  let warning = ""
  let previous = { selection: [], note: "" }
  for (;;) {
    const answerField = multi
      ? {
          type: "array",
          title: "Answers",
          description: "Select every correct option.",
          minItems: 1,
          items: { anyOf: choices },
          ...(previous.selection.length ? { default: previous.selection } : {}),
        }
      : { type: "string", title: "Answer", oneOf: choices }
    const res = await ctx.elicit({
      mode: "form",
      message: dialogMessage(warning && `⚠ ${warning}`, question, context),
      requestedSchema: {
        type: "object",
        properties: {
          [multi ? "answers" : "answer"]: answerField,
          note: previous.note ? { ...note, default: previous.note } : note,
        },
        required: [multi ? "answers" : "answer"],
      },
    })
    if (res.action !== "accept" || !res.content) return null

    const noteText = typeof res.content.note === "string" ? res.content.note.trim() : ""
    const raw = multi ? res.content.answers : [res.content.answer]
    const selection = (Array.isArray(raw) ? raw : []).map(String).filter(Boolean)
    const response = { dontKnow: false, ...(noteText ? { note: noteText } : {}), answers: [] }

    // "I don't know" is exclusive: it can't be combined with real answers.
    if (selection.includes(DONT_KNOW_VALUE)) {
      if (selection.length === 1) return { ...response, dontKnow: true }
      warning = `"${DONT_KNOW_LABEL}" can't be combined with other answers — pick one or the other.`
      previous = { selection, note: noteText }
      continue
    }
    if (selection.length === 0) {
      warning = "Select at least one answer before submitting."
      previous = { selection, note: noteText }
      continue
    }
    response.answers = sortAnswers(
      selection.map((v) => {
        const index = Number(v)
        return { label: options[index - 1].label, value: options[index - 1].value, index }
      }),
    )
    return response
  }
}

// Shared feedback text, shown after the user submits: the verdict first (the
// dialog shows only the first 4 lines), then the explanation.
export function feedbackText(options, selectedIndices, correctIndices, explanation, dontKnow = false) {
  const correct = !dontKnow && isCorrect(selectedIndices, correctIndices)
  const correctStr = correctIndices.map((i) => formatOptionRef(options, i)).join(", ")
  let verdict
  if (dontKnow) {
    // No guess was made — only reveal the correct answer(s); never show ✗.
    verdict = `· You said: I don't know — correct answer: ${correctStr}`
  } else if (correct) {
    verdict = `✓ Correct! — ${correctStr}`
  } else {
    verdict = `✗ Incorrect — correct answer: ${correctStr}`
  }
  return dialogMessage(verdict, explanation)
}

/** The read-only feedback dialog (Enter/Esc to continue). Never fails the quiz. */
async function showFeedback(ctx, options, response, correctIndices, explanation) {
  const text = feedbackText(
    options,
    response.answers.map((a) => a.index),
    correctIndices,
    explanation,
    response.dontKnow,
  )
  try {
    await ctx.elicit({ mode: "form", message: text, requestedSchema: { type: "object", properties: {} } })
  } catch {
    // The answer is already graded; a failed/dismissed feedback dialog is harmless.
  }
}

// ── tools ───────────────────────────────────────────────────────────────────

// The answered quiz waiting for its key: { question, context, mode, options, response }.
// One at a time — the dialogs are serialized anyway, and quiz_grade takes no id.
let pending = null

export const quizTool = {
  name: "quiz",
  title: "quiz",
  description:
    "Ask the user a GRADED question with a known correct answer, then grade it and give feedback. Unlike ask_user_question (which collects preferences/decisions with no right answer), quiz always has a correct answer supplied by you, marks the user's selection right/wrong (✓/✗), reveals the correct answer, and shows an explanation. Use it to (1) assess what the learner already understands before teaching, and (2) run tight practice/retrieval loops after explaining, or probe understanding whenever you're unsure they've got it. Options-only: single-select or multi-select, plus an automatic 'I don't know' choice so the user can signal a genuine gap instead of guessing. An always-present optional note field lets the user attach a free-text note to ANY answer; it reaches you only when non-empty. No free-text answers; for non-graded questions use ask_user_question instead.\n\n" +
    "TWO CALLS, so the answer key is never on screen before the user answers: `quiz` takes ONLY the question and options and shows the dialog; when it returns, the user has answered but their choice is hidden from you, so immediately call `quiz_grade` with correctAnswer and explanation, the key you meant when you wrote the question. quiz_grade grades, shows the feedback, and returns what they picked.",
  // pi put promptSnippet/promptGuidelines in the system prompt. Claude Code caps
  // MCP server instructions and tool descriptions at 2048 chars each, so the
  // per-parameter rules live in the parameter descriptions above and these
  // are the rest (they go into the server's instructions; see learn-server.mjs).
  promptGuidelines: [
    "quiz is GRADED; ask_user_question is not. If the question has a correct answer, use quiz. If you just need a preference, decision, or open-ended input, use ask_user_question.",
    "Every quiz is followed by quiz_grade (correctAnswer + explanation). Never put the answer or its explanation in the quiz call or in your message before the user answers.",
    "If a result comes back as dontKnow, the user honestly did not know and did NOT guess; treat it as a genuine knowledge gap to teach into, not as a wrong answer.",
    "Any answer (right, wrong, or 'I don't know') may carry an optional free-text `note` the user typed in the always-present note field. When present it reflects what they were thinking or unsure about; read it and let it steer your follow-up. It is omitted entirely when empty.",
    "To probe nuance, ask several quick quiz questions and adapt each one based on the previous answers, rather than writing one giant question.",
  ],
  inputSchema: QuizParams,

  /**
   * @param {any} params
   * @param {{ elicit: (p: any) => Promise<any>, canElicit: boolean, toolUseId?: string, signal?: AbortSignal, saveTranscript: () => Promise<void> }} ctx
   */
  async handler(params, ctx) {
    // An answer left ungraded (turn interrupted, or quiz_grade skipped) is
    // dropped, not allowed to block; whatever this call returns says so.
    const dropped = pending?.question
    pending = null
    const res = await runQuiz(params, ctx)
    if (dropped) res.content[0].text += `\n(The previous quiz, "${dropped}", was never graded; its answer was dropped.)`
    return res
  },
}

/** Show the quiz dialog and hold the answer for quiz_grade. */
async function runQuiz(params, ctx) {
  const question = String(params.question ?? "")
  const context = String(params.details ?? "").trim() || undefined
  const mode = params.multiSelect ? "multi-select" : "single-select"

  // Shuffle for display (default on); quiz_grade resolves the key against
  // this exact order, so grading matches what the user saw.
  let options
  try {
    options = displayedOptions(params.options, { shuffle: params.shuffle, seed: ctx.toolUseId })
  } catch (e) {
    return unavailableResult(question, mode, `quiz ${e.message}`, context)
  }

  if (ctx.signal?.aborted) {
    return cancelledResult(question, mode, context)
  }

  if (options.length < 2) {
    return unavailableResult(question, mode, "quiz requires at least two options", context)
  }

  if (!ctx.canElicit) {
    return unavailableResult(question, mode, "quiz requires interactive mode UI", context)
  }

  return withUILock(async () => {
    // Get the lesson text written before this call into the md-log before the dialog opens.
    await ctx.saveTranscript()
    let response
    try {
      response = await askQuiz(ctx, question, context, options, mode === "multi-select")
    } catch (e) {
      if (isAbort(e, ctx.signal)) return cancelledResult(question, mode, context)
      return unavailableResult(question, mode, `quiz dialog failed: ${e.message}`, context)
    }
    if (!response) {
      return cancelledResult(question, mode, context)
    }
    pending = { question, context, mode, options, response }
    return result(
      "The user has answered. Their choice stays hidden from you until you commit the answer key: call quiz_grade now with correctAnswer (the option value(s)) and explanation — the key you meant when you wrote the question.",
      {
        status: "awaiting_grade",
        question,
        context,
        mode,
        options: options.map((o, i) => ({ index: i + 1, label: o.label })),
      },
    )
  })
}

export const quizGradeTool = {
  name: "quiz_grade",
  title: "quiz_grade",
  description:
    "Second half of `quiz`: commit the answer key for the quiz the user just answered. Grades their (hidden) answer against your correctAnswer, shows them the ✓/✗ feedback with your explanation, and returns what they picked, the correct answer, their optional note and the explanation. Call it right after quiz returns \"The user has answered\"; don't ask anything else in between.",
  promptGuidelines: [],
  inputSchema: QuizGradeParams,

  /**
   * @param {any} params
   * @param {{ elicit: (p: any) => Promise<any>, canElicit: boolean, signal?: AbortSignal }} ctx
   */
  async handler(params, ctx) {
    if (!pending) {
      return result("quiz_grade: no answered quiz is waiting to be graded — call quiz first.", {
        status: "invalid",
        message: "no answered quiz is waiting",
      })
    }
    const { question, context, mode, options, response } = pending
    const explanation = String(params.explanation ?? "").trim()
    const resolved = resolveCorrect(params.correctAnswer, options)
    const correctIndices = resolved.indices
    const correctError =
      resolved.error ??
      (mode === "single-select" && correctIndices.length !== 1
        ? "correctAnswer must be exactly one option value for a single-select quiz"
        : undefined)
    if (correctError) {
      // Keep the answer waiting: the model fixes the value and calls again.
      return result(`quiz_grade ${correctError} — the user's answer is still waiting; call quiz_grade again with a valid value.`, {
        status: "invalid",
        message: correctError,
      })
    }
    pending = null

    return withUILock(async () => {
      if (ctx.canElicit) await showFeedback(ctx, options, response, correctIndices, explanation)
      return buildResult(question, context, mode, options, response, correctIndices, explanation)
    })
  },
}
