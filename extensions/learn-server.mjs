#!/usr/bin/env node
/**
 * learn — the MCP server for the MAIN session: `quiz` and `ask_user_question`.
 *
 * Claude Code has no in-process extension API, so the two pi extensions
 * (quiz.ts, ask-user-question.ts) become tools on one stdio MCP server,
 * registered in the project's .mcp.json. Their pop-ups are native elicitation
 * dialogs. In Claude Code the tools are named mcp__learn__ask_user_question,
 * mcp__learn__quiz and mcp__learn__quiz_grade (the quiz's answer key arrives
 * in a second call, after the user has answered — see quiz.mjs).
 *
 * Each pi tool's promptSnippet/promptGuidelines went into pi's system prompt;
 * the equivalent here is the server's `instructions`, which Claude Code puts
 * in the system prompt under "MCP Server Instructions" (capped at 2048 chars,
 * so rules about single parameters live in those parameters' descriptions).
 */

import { serveTools } from "./_mcp.mjs"
import { askUserQuestionTool } from "./ask-user-question.mjs"
import { quizGradeTool, quizTool } from "./quiz.mjs"

const tools = [askUserQuestionTool, quizTool, quizGradeTool].map((tool) => ({
  ...tool,
  // Always in the prompt, never deferred behind tool search — like a pi tool.
  _meta: { "anthropic/alwaysLoad": true },
}))

// Claude Code truncates server instructions past 2048 chars (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH).
const instructions = [
  "These tools pop up a dialog in the user's terminal and wait for the answer. " +
    "The dialog shows only ~4 short lines of question + details, so keep `question` to a sentence or two; " +
    "longer material (a worked example, a formula) belongs in your message before the call; the learner reads it, rendered, in the md-log while the dialog is open.",
  ...tools
    .filter((tool) => tool.promptGuidelines.length)
    .map((tool) => [`## ${tool.name}`, ...tool.promptGuidelines.map((g) => `- ${g}`)].join("\n")),
].join("\n\n")

await serveTools({ name: "learn", version: "1.0.0", instructions, tools })
