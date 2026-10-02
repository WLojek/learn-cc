# learn: an AI learning system for Claude Code

[![video](assets/thumbnail.png)](https://www.youtube.com/watch?v=kzcI5F4tGiU)

A [Claude Code](https://code.claude.com) setup that turns Claude into a tutor. Ask it to teach you anything with `/teach <topic>`. It works like this:
- It first finds out what you already know, then explains in small steps.
- It checks your understanding with quizzes that pop up in the terminal.
- It draws diagrams when a picture is clearer.
- It fact-checks itself with a research subagent.

Every lesson is mirrored into a markdown note that you read in Obsidian, LaTeX and diagrams included.

> **Origin.** This is a fork of [amosblomqvist/learn](https://github.com/amosblomqvist/learn), the system from the video [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU), which was built for the [pi](https://github.com/earendil-works/pi) coding agent. This fork is rebuilt for **Claude Code** and doesn't use pi at all. The teaching skill is the original; everything around it is built from Claude Code skills, subagents, MCP servers and hooks. If you know the pi version, see [Differences from the pi version](#differences-from-the-pi-version).

## What you get

- **`/teach <topic>`**: the teaching skill, with its philosophy and its process.
- **Quiz and question popups**: graded quizzes (✓/✗, the correct answer and an explanation), plus multiple-choice and free-text questions, shown as dialogs in the terminal. A quiz's answer key stays hidden until you've answered.
- **`/md-log <note>`**: mirrors the session into a markdown note, including your prompts, the lessons, the quizzes with your answers, and the diagrams. The status line shows the linked note.
- **Diagrams**: run `/visualize`, or the teacher uses it on its own when an idea is clearer as a picture. A subagent writes Mermaid or SVG, renders it, looks at the result, and saves a PNG into `viz/`, which is embedded in the note.
- **A researcher subagent**: searches the web to verify facts before they're taught.

## Requirements

- [Claude Code](https://code.claude.com), with a Claude subscription or an API key. Tested with v2.1.287. It needs MCP elicitation (the popups), the `UserPromptExpansion` hook and agent-scoped `mcpServers` (the diagram tools).
- Node.js ≥ 20 (for the MCP servers and hooks)
- Google Chrome or Chromium, to render the diagrams. Mermaid renders through the bundled `@mermaid-js/mermaid-cli`. SVG renders through `rsvg-convert` or ImageMagick if you have them, otherwise through headless Chrome. With no browser installed, run `npx puppeteer browsers install chrome` in `.claude/extensions`.
- [Obsidian](https://obsidian.md) to read the note. Any markdown viewer that renders callouts, LaTeX and `![[embeds]]` also works.

## Install

This repo **is** a `.claude` directory, the folder Claude Code reads a project's skills, subagents and settings from. From your learning project's folder (a new, empty folder is fine):

```bash
git clone https://github.com/WLojek/learn-cc .claude
cd .claude/extensions
npm install
cd ../..
cp .claude/mcp.json .mcp.json
claude
```

`npm install` may warn that puppeteer's install script wasn't run. That's harmless if Chrome is installed.

The `cp` puts `.mcp.json` in the project root. It registers the `learn` MCP server, which serves the quiz and question popups. Claude Code reads a project's MCP servers only from there, never from inside `.claude/`.

On the first start, Claude Code asks whether you trust the folder and lists the tools this setup pre-approves. Choose **Yes, I trust this folder**. Until the folder is trusted, Claude Code doesn't start the `learn` server, apply the project's permissions or start the subagents' diagram tools.

If your project already has a `.claude/` folder, copy the pieces into it instead and merge `settings.json` by hand (the hook commands expect the files under `.claude/extensions/`).

## Using it

1. **Open the project folder itself as an Obsidian vault** (Obsidian → *Manage vaults…* → *Open folder as vault*). Don't create a separate vault. Diagrams are saved to `viz/` in the project and embedded in your note, so the vault has to contain both.
2. **Create the note.** `/md-log` links an existing file; it never creates one. In Obsidian, name the note `lessons`, because Obsidian adds the `.md` itself. Or type `! touch lessons.md` in Claude Code (the `!` prefix runs a shell command).
3. **Link it:** `/md-log lessons.md`. The path is relative to the project root. Claude Code shows the result as "UserPromptSubmit operation blocked by hook: Linked: …". That's just how it displays a command a hook handled. The status line shows `🗒 lessons.md`.
4. **Learn:** `/teach <any topic>`, e.g. `/teach how TCP works`. Everything you and Claude write is mirrored into the note and rendered (LaTeX, mermaid, embeds): lessons, quizzes, answers and diagrams. The lesson text reaches the note before a popup opens, so you can read it rendered while you answer.
5. **Answer the popups in the terminal.** → opens the options and Space selects; in a multi-select list, Space toggles each option and ← closes the list. Then move down to **Accept** and press Enter. Esc skips the question.

### A note is linked to one session

The link belongs to the Claude Code session where you ran `/md-log`. It is not tied to the project.

- **Continuing:** `claude --continue` or `claude --resume` reopens a session together with its link, and logging carries on.
- **New session:** a fresh `claude` or `/clear` starts a new session with **no note linked**. Run `/md-log` again.
- **Link first, so you don't lose notes:**
  - Run as the first thing in a new session, `/md-log lessons.md` adds the new lesson below what's already in the note.
  - Run in a session that already has messages, it fills the note with that session's history so far, **replacing the note's content**.
  - So to add a lesson to an existing note, link it before you start. Otherwise, link a new note (e.g. one per topic: `! touch python.md`, then `/md-log python.md`).
- **Stopping:** `/md-unlog` stops logging. The note keeps what's in it.

## Good to know

- **Quiz feedback takes a few seconds.** A quiz is two tool calls. `quiz` shows the question, and `quiz_grade` brings the answer key and explanation once you've answered. Claude Code shows every tool argument in its transcript view (Ctrl+O, even while a popup is open), so a single call would reveal the answer. Claude commits the key before it sees your choice, so it can't bend the key to fit your answer.
- **Popups wait as long as you need.** From v2.1.287, Claude Code moves an MCP call that runs longer than 2 minutes into the background, which would split a slow quiz answer off from the lesson. This project's `settings.json` turns that off (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`), so take your time.
- **Popups are short.** A dialog shows at most 4 lines of question text, each cut at the terminal width. The full question is in the note. Option descriptions appear inline, after the label. The free-text answer is a single-line field. The quiz feedback popup shows the verdict and the explanation; the per-option ✓/✗ list is in the note.
- **Pre-approved tools.** `settings.json` allows the quiz, question and diagram tools and web search/fetch without asking. The researcher's shell commands still go through your Claude Code permission mode. A denylist hook (`extensions/safe-bash.mjs`, the same list pi used) also rejects some obviously destructive commands, but it's a best-effort filter, not a sandbox.
- **Claude Code's built-in `AskUserQuestion` is turned off** in this project (`permissions.deny`), so every question goes through the popups above and lands in the note. Remove the deny rule if you want it back.
- **Interactive sessions only.** In `claude -p` (print mode) popups can't be shown, so quizzes come back cancelled.
- **Subagents report back to the teacher.** Claude Code may run the researcher and the diagram makers in the background while the teacher waits for their result; watch them work in the agents panel (←) or with Ctrl+O.
- **You can skip the subagents.** The main session does the teaching; you just lose the fact checking and the diagrams.
- **The teaching skill is written for one learner** (the original author). Edit `skills/teach/SKILL.md` to fit how you learn best.

## What's in the repo

- `skills/teach/`: the teaching philosophy and process
- `skills/visualize/`: adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `skills/md-log/`, `skills/md-unlog/`: the `/md-log <file>` and `/md-unlog` commands
- `agents/`: the subagents. `researcher` does web research; `mermaid-maker` and `svg-maker` draw diagrams.
- `extensions/learn-server.mjs`: the `learn` MCP server with the popup tools:
  - `extensions/ask-user-question.mjs`: questions (`ask_user_question`)
  - `extensions/quiz.mjs`: graded quizzes (`quiz` + `quiz_grade`)
- `extensions/md-log.mjs`: the hooks that mirror the session into the linked note
- `extensions/statusline.mjs`: adds `🗒 <note>` to the status line (after your own status line, if you have one)
- `extensions/visual-tools/`: the MCP server the diagram subagents draw and render with
- `extensions/safe-bash.mjs`: the denylist hook for the researcher's shell
- `extensions/test/`: the test suite. Run it with `cd .claude/extensions && npm test`.
- `settings.json`: wires it together with hooks, status line, MCP server approval, tool permissions, and the setting that keeps popups in the foreground
- `mcp.json`: the `learn` server registration, copied to the project root as `.mcp.json`

## Differences from the pi version

For anyone coming from [amosblomqvist/learn](https://github.com/amosblomqvist/learn). The skills and subagents keep the original's wording; the pi extensions are rebuilt with Claude Code's own mechanisms.

| pi | Claude Code (this fork) |
| --- | --- |
| `.pi/skills/*/SKILL.md` | `.claude/skills/*/SKILL.md`. `teach` is unchanged apart from tool names and a note on the two-call quiz; `visualize` calls the subagents through the Agent tool |
| `.pi/agents/*.md` + pi-interactive-subagents `subagent()` | `.claude/agents/*.md`, run with the Agent tool |
| custom tools `quiz`, `ask_user_question` (extensions with TUI popups) | MCP server `learn` with `ask_user_question`, and `quiz` split into `quiz` + `quiz_grade` so the answer key stays sealed. The popups are native MCP elicitation dialogs |
| tool `promptSnippet` / `promptGuidelines` (system prompt) | MCP server instructions + tool and parameter descriptions |
| `md-log` extension (session events, `/md-log`, `/md-unlog`) | command hooks reading the session transcript; the commands are intercepted by a `UserPromptSubmit` hook |
| `ctx.ui.setStatus("md-log", …)` | the status line: your own status line, plus `🗒 <file>` |
| `visual-tools` registered into child pi processes | MCP server declared inline in the makers' `mcpServers:` frontmatter, started only for those subagents |
| researcher's `safe_bash` | `Bash` + a `PreToolUse` hook with the same denylist |
| `model: openrouter/z-ai/glm-5.3`, `anthropic/claude-sonnet-5`, `thinking: medium` | `model: sonnet`, `effort: medium` |

What works differently:

- **Popups** are Claude Code's elicitation dialogs, not custom TUI components, hence the limits listed under [Good to know](#good-to-know).
- **The quiz is two calls** (`quiz` + `quiz_grade`) instead of one. pi never displayed the answer key, but Claude Code shows every tool argument.
- **Quiz shuffle is seeded by the call's tool-use id**: random per question, but reproducible, which md-log needs to log the question in on-screen order before you answer.
- **md-log works from the transcript** instead of in-process events. Claude Code writes a response to its transcript only when its tool calls finish, except when a running tool reports progress. So the popup tools report progress ("waiting for your answer") before opening a dialog, and an `Elicitation` hook logs the lesson text above the question while the dialog is open. The link is stored per session in `.claude/.md-log/`, as pi stored it in the session. `/md-log` and `/md-unlog` show their result as "blocked by hook". The assistant's callouts are labelled `CLAUDE` instead of `PI`.
- **Subagents aren't interactive panes.** pi-interactive-subagents ran each subagent in a tmux pane you could watch and talk to; Claude Code runs them itself and hands their final message back to the teacher.
- **Claude models only.** The researcher used GLM-5.3 via OpenRouter; here it uses Sonnet.
- **Permissions.** pi had no permission prompts; here `settings.json` pre-approves the tools the system needs.
- **The built-in `AskUserQuestion` is denied.** This is the equivalent of the pi README's "use this `ask-user-question` in place of any other".
