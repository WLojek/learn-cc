import { choice, dialogMessage, isAbort, optionTitle, withUILock } from "./_ui.mjs"

// ────────────────────────────────────────────────────────────────────────────
// ask_user_question — ask the user ONE question and pause until they answer.
// No right or wrong answer (that's `quiz`). Three modes:
//
//   text           — no options: a free-text answer
//   single-select  — pick one option, or "Other" and type a custom answer
//   multi-select   — pick any number of options (+ "Other")
//
// Rendered as Claude Code's native MCP elicitation dialogs (see _ui.mjs).
// Choosing "Other" opens a second dialog for the custom text; Esc there goes
// back to the options, Esc on the options cancels.
// ────────────────────────────────────────────────────────────────────────────

/** `_meta` key on the tool result that carries the structured details (read by md-log; never sent to the model). */
export const ASK_META_KEY = "learn/ask_user_question"

const OTHER_VALUE = "__other__"

const OptionSchema = {
  type: "object",
  properties: {
    label: {
      type: "string",
      description:
        'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
    },
    value: {
      type: "string",
      description: "Optional machine-readable value returned for the option. Defaults to the label.",
    },
    description: { type: "string", description: "Optional extra detail shown next to the option." },
  },
  required: ["label"],
}

const AskUserQuestionParams = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The single question to ask the user. Ask exactly one question per tool call.",
    },
    details: { type: "string", description: "Optional extra context or instructions shown under the question." },
    options: {
      type: "array",
      items: OptionSchema,
      description:
        "Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
    },
    multiSelect: {
      type: "boolean",
      description: "Set to true to allow multiple answers to be selected for a question.",
    },
  },
  required: ["question"],
}

function normalizeOptions(options) {
  return (options || [])
    .map((option) => ({
      label: String(option?.label ?? "").trim(),
      value: String(option?.value ?? "").trim() || String(option?.label ?? "").trim(),
      description: String(option?.description ?? "").trim() || undefined,
    }))
    .filter((option) => option.label.length > 0)
}

function getOtherLabel(options) {
  return options.some((option) => option.label.toLowerCase() === "other") ? "Other (custom)" : "Other"
}

function formatAnswerForModel(answer) {
  switch (answer.type) {
    case "text":
      return answer.label
    case "other":
      return `Other: ${answer.label}`
    case "option":
      return `${answer.index}. ${answer.label}`
  }
}

function answerSortRank(answer) {
  switch (answer.type) {
    case "option":
      return answer.index
    case "other":
      return Number.MAX_SAFE_INTEGER - 1
    case "text":
      return Number.MAX_SAFE_INTEGER
  }
}

function sortAnswers(answers) {
  return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b))
}

// ── results ─────────────────────────────────────────────────────────────────
// The model reads `content` (same text as the pi tool). The structured details
// ride in `_meta`, which Claude Code stores in the transcript but never sends
// to the model — md-log reads them from there.

function result(text, details) {
  return { content: [{ type: "text", text }], _meta: { [ASK_META_KEY]: details } }
}

function cancelledResult(question, mode, context) {
  const message = "User cancelled the question"
  return result(message, { status: "cancelled", question, context, mode, answers: [], message })
}

function unavailableResult(question, mode, message, context) {
  return result(message, { status: "unavailable", question, context, mode, answers: [], message })
}

function buildResult(question, context, mode, answers) {
  let text
  if (mode === "text") {
    const answer = answers[0]
    text = answer.label.trim().length > 0 ? `User answered: ${answer.label}` : "User submitted an empty response"
  } else if (mode === "single-select") {
    text = `User selected: ${formatAnswerForModel(answers[0])}`
  } else {
    text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`
  }
  return result(text, { status: "answered", question, context, mode, answers })
}

// ── dialogs ─────────────────────────────────────────────────────────────────

function messageFor(question, context, warning) {
  return dialogMessage(warning && `⚠ ${warning}`, question, context)
}

/** Free-text answer. Returns the text ("" allowed), or null on cancel. */
async function askText(ctx, question, context) {
  const res = await ctx.elicit({
    mode: "form",
    message: messageFor(question, context),
    requestedSchema: {
      type: "object",
      properties: { answer: { type: "string", title: "Your answer" } },
    },
  })
  if (res.action !== "accept") return null
  return typeof res.content?.answer === "string" ? res.content.answer.trim() : ""
}

/** The custom-answer dialog behind "Other". Returns the text, or null to go back. */
async function askOther(ctx, question, previous) {
  const res = await ctx.elicit({
    mode: "form",
    message: messageFor(question, "Write your custom answer:"),
    requestedSchema: {
      type: "object",
      properties: {
        other: { type: "string", title: "Your answer", minLength: 1, ...(previous ? { default: previous } : {}) },
      },
      required: ["other"],
    },
  })
  if (res.action !== "accept") return null
  const text = typeof res.content?.other === "string" ? res.content.other.trim() : ""
  return text || null
}

function optionChoices(options) {
  return [
    ...options.map((option, i) => choice(String(i + 1), optionTitle(i + 1, option))),
    choice(OTHER_VALUE, getOtherLabel(options)),
  ]
}

function optionAnswer(options, value) {
  const index = Number(value)
  const option = options[index - 1]
  return { type: "option", label: option.label, value: option.value, index }
}

async function askSingleChoice(ctx, question, context, options) {
  const choices = optionChoices(options)
  for (;;) {
    const res = await ctx.elicit({
      mode: "form",
      message: messageFor(question, context),
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string", title: "Answer", oneOf: choices } },
        required: ["answer"],
      },
    })
    if (res.action !== "accept" || !res.content?.answer) return null
    const value = String(res.content.answer)
    if (value !== OTHER_VALUE) return optionAnswer(options, value)
    const custom = await askOther(ctx, question)
    if (custom !== null) return { type: "other", label: custom, value: custom }
    // Esc on the custom answer → back to the options.
  }
}

async function askMultiChoice(ctx, question, context, options) {
  const choices = optionChoices(options)
  let selection = []
  let other = ""
  let warning = ""
  for (;;) {
    const res = await ctx.elicit({
      mode: "form",
      message: messageFor(question, context, warning),
      requestedSchema: {
        type: "object",
        properties: {
          answers: {
            type: "array",
            title: "Answers",
            description: "Select all that apply.",
            minItems: 1,
            items: { anyOf: choices },
            ...(selection.length ? { default: selection } : {}),
          },
        },
        required: ["answers"],
      },
    })
    if (res.action !== "accept" || !res.content) return null
    selection = (Array.isArray(res.content.answers) ? res.content.answers : []).map(String)
    if (selection.length === 0) {
      warning = "Select at least one answer before submitting."
      continue
    }
    const answers = selection.filter((v) => v !== OTHER_VALUE).map((v) => optionAnswer(options, v))
    if (selection.includes(OTHER_VALUE)) {
      const custom = await askOther(ctx, question, other)
      if (custom === null) {
        // Esc on the custom answer → back to the options, selection kept.
        warning = ""
        continue
      }
      other = custom
      answers.push({ type: "other", label: custom, value: custom })
    }
    return sortAnswers(answers)
  }
}

// ── tool ────────────────────────────────────────────────────────────────────

export const askUserQuestionTool = {
  name: "ask_user_question",
  title: "ask_user_question",
  description:
    "Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together.",
  // pi's promptGuidelines; they go into the server's instructions (see learn-server.mjs).
  promptGuidelines: [
    "Ask exactly one question per tool call. If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
    'Users will always be able to select "Other" to provide custom text input when options are provided.',
    "Use multiSelect: true only when you need multiple answers to the same question.",
    'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
    "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear, or when multiple valid paths exist and the preferred path depends on user choice.",
  ],
  inputSchema: AskUserQuestionParams,

  /**
   * @param {any} params
   * @param {{ elicit: (p: any) => Promise<any>, canElicit: boolean, signal?: AbortSignal, saveTranscript: () => Promise<void> }} ctx
   */
  async handler(params, ctx) {
    const question = String(params.question ?? "")
    const options = normalizeOptions(params.options)
    const context = String(params.details ?? "").trim() || undefined
    const mode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select"

    if (ctx.signal?.aborted) {
      return cancelledResult(question, mode, context)
    }

    if (!ctx.canElicit) {
      return unavailableResult(question, mode, "ask_user_question requires interactive mode UI", context)
    }

    return withUILock(async () => {
      // Get the text written before this call (e.g. a plan to approve) into the md-log before the dialog opens.
      await ctx.saveTranscript()
      try {
        if (mode === "text") {
          const answer = await askText(ctx, question, context)
          if (answer === null) return cancelledResult(question, mode, context)
          return buildResult(question, context, mode, [{ type: "text", label: answer, value: answer }])
        }

        if (mode === "single-select") {
          const answer = await askSingleChoice(ctx, question, context, options)
          if (!answer) return cancelledResult(question, mode, context)
          return buildResult(question, context, mode, [answer])
        }

        const answers = await askMultiChoice(ctx, question, context, options)
        if (!answers) return cancelledResult(question, mode, context)
        return buildResult(question, context, mode, answers)
      } catch (e) {
        if (isAbort(e, ctx.signal)) return cancelledResult(question, mode, context)
        return unavailableResult(question, mode, `ask_user_question dialog failed: ${e.message}`, context)
      }
    })
  },
}
