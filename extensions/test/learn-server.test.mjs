import assert from "node:assert/strict"
import { after, describe, test } from "node:test"
import { QUIZ_META_KEY, displayedOptions } from "../quiz.mjs"
import { ASK_META_KEY } from "../ask-user-question.mjs"
import { call, closeAll, connect, text } from "./helpers.mjs"

const PLANETS = [
  { label: "Mercury", value: "mercury" },
  { label: "Venus", value: "venus" },
  { label: "Earth", value: "earth" },
  { label: "Mars", value: "mars" },
]

/** Find the elicitation `const` of the option with this label (titles are "N. label"). */
function constFor(dialog, field, label) {
  const prop = dialog.requestedSchema.properties[field]
  const list = prop.oneOf ?? prop.items.anyOf
  const hit = list.find((c) => c.title === label || c.title.replace(/^\d+\. /, "") === label)
  assert.ok(hit, `no choice "${label}" in ${JSON.stringify(list)}`)
  return hit.const
}

const quizArgs = (extra = {}) => ({
  question: "Which planet is closest to the Sun?",
  options: PLANETS,
  ...extra,
})
const KEY = { correctAnswer: "mercury", explanation: "Mercury orbits at ~0.39 AU." }

/** Answer dialog i=0 with `answer`, accept every later dialog (the feedback). */
const answering = (answer) => (d, i) => (i === 0 ? { action: "accept", content: answer(d) } : { action: "accept", content: {} })

describe("learn server", () => {
  test("lists the tools, always-loaded, with instructions within Claude Code's limits", async () => {
    const { client, close } = await connect("learn-server.mjs", { answer: () => ({ action: "cancel" }) })
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ["ask_user_question", "quiz", "quiz_grade"])
    for (const t of tools) assert.equal(t._meta["anthropic/alwaysLoad"], true)
    const instructions = client.getInstructions()
    assert.match(instructions, /## quiz/)
    assert.match(instructions, /quiz is GRADED; ask_user_question is not/)
    assert.match(instructions, /## ask_user_question/)
    // Claude Code truncates server instructions and tool descriptions past 2048 chars.
    assert.ok(instructions.length <= 2048, `instructions are ${instructions.length} chars`)
    for (const t of tools) assert.ok(t.description.length <= 2048, `${t.name} description is ${t.description.length} chars`)
    await close()
  })

  test("sealed: the quiz call has no place for the answer key", async () => {
    const { client, close } = await connect("learn-server.mjs", { answer: () => ({ action: "cancel" }) })
    const { tools } = await client.listTools()
    const quiz = tools.find((t) => t.name === "quiz")
    assert.ok(!("correctAnswer" in quiz.inputSchema.properties))
    assert.ok(!("explanation" in quiz.inputSchema.properties))
    assert.equal(quiz.inputSchema.additionalProperties, false)
    const grade = tools.find((t) => t.name === "quiz_grade")
    assert.deepEqual(grade.inputSchema.required, ["correctAnswer", "explanation"])
    await close()
  })
})

describe("quiz + quiz_grade", () => {
  test("quiz shows the answer form and hides the choice; quiz_grade shows feedback and returns the pi result", async () => {
    const { client, dialogs, close } = await connect("learn-server.mjs", {
      answer: answering((d) => ({ answer: constFor(d, "answer", "Mercury"), note: "orbits?" })),
    })
    const q = await call(client, "quiz", quizArgs(), "toolu_A")
    assert.equal(dialogs.length, 1)
    // answer form: real options + "I don't know" last, note field present
    const titles = dialogs[0].requestedSchema.properties.answer.oneOf.map((c) => c.title)
    assert.equal(titles.at(-1), "I don't know")
    assert.equal(titles.length, 5)
    assert.ok(dialogs[0].requestedSchema.properties.note)
    assert.deepEqual(dialogs[0].requestedSchema.required, ["answer"])
    // the model learns nothing about the choice (or the note) before committing the key
    assert.match(text(q), /^The user has answered\. Their choice stays hidden/)
    assert.doesNotMatch(text(q), /Mercury|orbits/)
    assert.equal(q._meta[QUIZ_META_KEY].status, "awaiting_grade")
    assert.equal(q._meta[QUIZ_META_KEY].options.length, 4)

    const r = await call(client, "quiz_grade", KEY, "toolu_A2")
    assert.equal(dialogs.length, 2)
    // feedback form: no fields, carries the verdict + explanation
    assert.deepEqual(dialogs[1].requestedSchema.properties, {})
    assert.match(dialogs[1].message, /^✓ Correct! — \d\. Mercury\n/)
    assert.match(dialogs[1].message, /Mercury orbits/)
    assert.match(text(r), /^User answered correctly\.\nSelected: \d\. Mercury\nCorrect: \d\. Mercury\nUser's note: orbits\?\nExplanation: Mercury orbits/)
    const d = r._meta[QUIZ_META_KEY]
    assert.equal(d.status, "answered")
    assert.equal(d.correct, true)
    assert.equal(d.dontKnow, false)
    assert.equal(d.note, "orbits?")
    assert.equal(d.options.length, 4)
    // graded once: nothing is waiting any more
    const again = await call(client, "quiz_grade", KEY)
    assert.match(text(again), /no answered quiz is waiting/)
    await close()
  })

  test("reports progress before the first dialog (makes Claude Code save the lesson text for md-log)", async () => {
    const events = []
    const { client, close } = await connect("learn-server.mjs", {
      answer: (d, i) => {
        events.push(`dialog${i}`)
        return { action: "accept", content: { answer: "1" } }
      },
    })
    await client.callTool(
      { name: "quiz", arguments: quizArgs(), _meta: { "claudecode/toolUseId": "toolu_P" } },
      undefined,
      { onprogress: () => events.push("progress") },
    )
    await client.callTool(
      { name: "ask_user_question", arguments: { question: "Ready?", options: [{ label: "Yes" }, { label: "No" }] } },
      undefined,
      { onprogress: () => events.push("progress") },
    )
    assert.deepEqual(events, ["progress", "dialog0", "progress", "dialog1"])
    await close()
  })

  test("display order is seeded by the quiz call's tool_use id (md-log can reproduce it)", async () => {
    const { client, close } = await connect("learn-server.mjs", { answer: () => ({ action: "accept", content: { answer: "1" } }) })
    const shown = []
    for (const id of ["toolu_X1", "toolu_X2", "toolu_X3", "toolu_X4", "toolu_X5"]) {
      const q = await call(client, "quiz", quizArgs(), id)
      const expected = displayedOptions(PLANETS, { seed: id }).map((o, i) => ({ index: i + 1, label: o.label }))
      assert.deepEqual(q._meta[QUIZ_META_KEY].options, expected)
      const r = await call(client, "quiz_grade", KEY)
      assert.deepEqual(r._meta[QUIZ_META_KEY].options, expected)
      shown.push(expected.map((o) => o.label).join(","))
    }
    assert.ok(new Set(shown).size > 1, "different ids should give different orders")
    await close()
  })

  test("shuffle:false keeps author order; wrong answer", async () => {
    const { client, close } = await connect("learn-server.mjs", { answer: answering(() => ({ answer: "2" })) })
    await call(client, "quiz", quizArgs({ shuffle: false }))
    const r = await call(client, "quiz_grade", KEY)
    assert.match(text(r), /^User answered incorrectly\.\nSelected: 2\. Venus\nCorrect: 1\. Mercury/)
    await close()
  })

  test("I don't know + note: distinct signal, never ✗", async () => {
    const { client, dialogs, close } = await connect("learn-server.mjs", {
      answer: answering(() => ({ answer: "dont_know", note: "never learned orbits" })),
    })
    await call(client, "quiz", quizArgs())
    const r = await call(client, "quiz_grade", KEY)
    assert.match(text(r), /^User selected "I don't know" — they did not attempt an answer/)
    assert.match(text(r), /User's note: never learned orbits/)
    assert.doesNotMatch(dialogs[1].message, /✗/)
    assert.match(dialogs[1].message, /^· You said: I don't know — correct answer: \d\. Mercury/)
    const d = r._meta[QUIZ_META_KEY]
    assert.equal(d.dontKnow, true)
    assert.equal(d.correct, false)
    assert.equal(d.note, "never learned orbits")
    await close()
  })

  test("multi-select: exact-set grading, I-don't-know exclusivity re-prompts", async () => {
    const args = {
      question: "Which are gas giants?",
      options: [
        { label: "Jupiter", value: "jupiter" },
        { label: "Saturn", value: "saturn" },
        { label: "Mars", value: "mars" },
      ],
      multiSelect: true,
    }
    const { client, dialogs, close } = await connect("learn-server.mjs", {
      answer: (d, i) => {
        if (i === 0) return { action: "accept", content: { answers: [constFor(d, "answers", "Jupiter"), "dont_know"] } }
        if (i === 1) {
          assert.match(d.message, /can't be combined/)
          assert.deepEqual(d.requestedSchema.properties.answers.default.length, 2)
          return { action: "accept", content: { answers: [constFor(d, "answers", "Jupiter"), constFor(d, "answers", "Saturn")] } }
        }
        return { action: "accept", content: {} }
      },
    })
    await call(client, "quiz", args)
    assert.equal(dialogs.length, 2)
    assert.equal(dialogs[0].requestedSchema.properties.answers.type, "array")
    assert.equal(dialogs[0].requestedSchema.properties.answers.minItems, 1)
    // stringified array is coerced
    const r = await call(client, "quiz_grade", { correctAnswer: '["jupiter", "saturn"]', explanation: "Both are gas giants." })
    assert.match(text(r), /^User answered correctly\./)
    await close()
  })

  test("a wrong key value is rejected and the answer keeps waiting", async () => {
    const { client, dialogs, close } = await connect("learn-server.mjs", { answer: answering((d) => ({ answer: constFor(d, "answer", "Venus") })) })
    await call(client, "quiz", quizArgs())
    let r = await call(client, "quiz_grade", { correctAnswer: "pluto", explanation: "x" })
    assert.match(text(r), /^quiz_grade correctAnswer "pluto" does not match any option value .* call quiz_grade again/)
    assert.equal(r._meta[QUIZ_META_KEY].status, "invalid")
    assert.equal(dialogs.length, 1, "no feedback for an invalid key")
    r = await call(client, "quiz_grade", KEY)
    assert.match(text(r), /^User answered incorrectly\.\nSelected: \d\. Venus/)
    await close()
  })

  test("cancel → cancelled result, nothing waits for a grade", async () => {
    const { client, dialogs, close } = await connect("learn-server.mjs", { answer: () => ({ action: "cancel" }) })
    const q = await call(client, "quiz", quizArgs())
    assert.equal(text(q), "User cancelled the quiz")
    assert.equal(q._meta[QUIZ_META_KEY].status, "cancelled")
    assert.equal(dialogs.length, 1)
    const r = await call(client, "quiz_grade", KEY)
    assert.match(text(r), /no answered quiz is waiting/)
    await close()
  })

  test("an ungraded answer is dropped by the next quiz, with a note", async () => {
    const { client, close } = await connect("learn-server.mjs", { answer: () => ({ action: "accept", content: { answer: "1" } }) })
    await call(client, "quiz", quizArgs({ question: "First?" }))
    const q = await call(client, "quiz", quizArgs({ question: "Second?" }))
    assert.match(text(q), /The previous quiz, "First\?", was never graded; its answer was dropped\./)
    const r = await call(client, "quiz_grade", KEY)
    assert.equal(r._meta[QUIZ_META_KEY].question, "Second?")
    await close()
  })

  test("the drop note also reaches the model when the next quiz is invalid or cancelled", async () => {
    // Dialogs: First → answered, Third → answered, Fourth → cancelled ("Second?" is invalid, no dialog).
    const replies = [{ action: "accept", content: { answer: "1" } }, { action: "accept", content: { answer: "1" } }, { action: "cancel" }]
    const { client, close } = await connect("learn-server.mjs", { answer: (d, i) => replies[i] })
    await call(client, "quiz", quizArgs({ question: "First?" }))
    let r = await call(client, "quiz", quizArgs({ question: "Second?", options: [PLANETS[0]] }))
    assert.match(text(r), /at least two options\n\(The previous quiz, "First\?", was never graded; its answer was dropped\.\)$/)
    await call(client, "quiz", quizArgs({ question: "Third?" }))
    r = await call(client, "quiz", quizArgs({ question: "Fourth?" }))
    assert.match(text(r), /^User cancelled the quiz\n\(The previous quiz, "Third\?", was never graded/)
    assert.match(text(await call(client, "quiz_grade", KEY)), /no answered quiz is waiting/)
    await close()
  })

  test("a key that looks like a list matches its option as-is", async () => {
    const LISTS = [
      { label: "[1, 2, 3]", value: "[1, 2, 3]" },
      { label: "[0, 1, 2, 3]", value: "[0, 1, 2, 3]" },
      { label: "[]", value: "[]" },
    ]
    const { client, close } = await connect("learn-server.mjs", { answer: answering((d) => ({ answer: constFor(d, "answer", "[1, 2, 3]") })) })
    await call(client, "quiz", quizArgs({ question: "list(range(1, 4))?", options: LISTS }))
    const r = await call(client, "quiz_grade", { correctAnswer: "[1, 2, 3]", explanation: "range stops before 4." })
    assert.match(text(r), /^User answered correctly\./)
    await close()
  })

  test("a single-select quiz takes exactly one correct value", async () => {
    const { client, dialogs, close } = await connect("learn-server.mjs", { answer: answering((d) => ({ answer: constFor(d, "answer", "Mercury") })) })
    await call(client, "quiz", quizArgs())
    let r = await call(client, "quiz_grade", { correctAnswer: ["mercury", "venus"], explanation: "x" })
    assert.match(text(r), /exactly one option value for a single-select quiz .* call quiz_grade again/)
    assert.equal(dialogs.length, 1, "no feedback for an invalid key")
    r = await call(client, "quiz_grade", KEY)
    assert.match(text(r), /^User answered correctly\./)
    await close()
  })

  test("validation errors are 'unavailable' results", async () => {
    const { client, close } = await connect("learn-server.mjs", { answer: () => ({ action: "cancel" }) })
    let r = await call(client, "quiz", quizArgs({ options: [PLANETS[0], { label: "Mercury again", value: "mercury" }] }))
    assert.match(text(r), /duplicate option value "mercury"/)
    assert.equal(r._meta[QUIZ_META_KEY].status, "unavailable")
    r = await call(client, "quiz", quizArgs({ options: [PLANETS[0]] }))
    assert.match(text(r), /at least two options/)
    await close()
  })

  test("no elicitation capability → unavailable", async () => {
    const { client, close } = await connect("learn-server.mjs")
    const r = await call(client, "quiz", quizArgs())
    assert.equal(text(r), "quiz requires interactive mode UI")
    await close()
  })
})

describe("ask_user_question", () => {
  test("text mode", async () => {
    const { client, dialogs, close } = await connect("learn-server.mjs", {
      answer: () => ({ action: "accept", content: { answer: "  how the internet routes packets " } }),
    })
    const r = await call(client, "ask_user_question", { question: "What do you want to learn?", details: "Be specific." })
    assert.equal(dialogs[0].message, "What do you want to learn?\nBe specific.")
    assert.equal(text(r), "User answered: how the internet routes packets")
    const d = r._meta[ASK_META_KEY]
    assert.equal(d.mode, "text")
    assert.deepEqual(d.answers, [{ type: "text", label: "how the internet routes packets", value: "how the internet routes packets" }])
    await close()
  })

  test("text mode empty response", async () => {
    const { client, close } = await connect("learn-server.mjs", { answer: () => ({ action: "accept", content: {} }) })
    const r = await call(client, "ask_user_question", { question: "Anything else?" })
    assert.equal(text(r), "User submitted an empty response")
    await close()
  })

  test("single-select, no shuffle, Other always offered", async () => {
    const { client, dialogs, close } = await connect("learn-server.mjs", {
      answer: (d) => ({ action: "accept", content: { answer: constFor(d, "answer", "Deep dive (Recommended)") } }),
    })
    const r = await call(client, "ask_user_question", {
      question: "How deep?",
      options: [{ label: "Deep dive (Recommended)" }, { label: "Overview", description: "10 minutes" }],
    })
    const titles = dialogs[0].requestedSchema.properties.answer.oneOf.map((c) => c.title)
    assert.deepEqual(titles, ["1. Deep dive (Recommended)", "2. Overview — 10 minutes", "Other"])
    assert.equal(text(r), "User selected: 1. Deep dive (Recommended)")
    await close()
  })

  test("single-select Other → custom text; Esc on custom goes back to options", async () => {
    const { client, dialogs, close } = await connect("learn-server.mjs", {
      answer: (d, i) => {
        if (i === 0) return { action: "accept", content: { answer: "__other__" } }
        if (i === 1) return { action: "cancel" } // back
        if (i === 2) return { action: "accept", content: { answer: "__other__" } }
        return { action: "accept", content: { other: "something else entirely" } }
      },
    })
    const r = await call(client, "ask_user_question", { question: "Pick", options: [{ label: "A" }, { label: "other" }] })
    assert.equal(dialogs.length, 4)
    assert.equal(dialogs[0].requestedSchema.properties.answer.oneOf.at(-1).title, "Other (custom)")
    assert.equal(text(r), "User selected: Other: something else entirely")
    await close()
  })

  test("multi-select with Other, answers sorted", async () => {
    const { client, close } = await connect("learn-server.mjs", {
      answer: (d, i) =>
        i === 0
          ? { action: "accept", content: { answers: ["__other__", constFor(d, "answers", "C"), constFor(d, "answers", "A")] } }
          : { action: "accept", content: { other: "D" } },
    })
    const r = await call(client, "ask_user_question", {
      question: "Which?",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      multiSelect: true,
    })
    assert.equal(text(r), "User selected:\n- 1. A\n- 3. C\n- Other: D")
    await close()
  })

  test("cancel and unavailable", async () => {
    let s = await connect("learn-server.mjs", { answer: () => ({ action: "decline" }) })
    let r = await call(s.client, "ask_user_question", { question: "Q?", options: [{ label: "A" }, { label: "B" }] })
    assert.equal(text(r), "User cancelled the question")
    await s.close()
    s = await connect("learn-server.mjs")
    r = await call(s.client, "ask_user_question", { question: "Q?" })
    assert.equal(text(r), "ask_user_question requires interactive mode UI")
    await s.close()
  })
})

after(closeAll)
