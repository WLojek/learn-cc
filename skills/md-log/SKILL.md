---
name: md-log
description: Mirror this session to an existing markdown file (if the session already has messages, they replace the file's content)
argument-hint: <existing-file.md>
disable-model-invocation: true
---

The `/md-log` command is handled by the md-log hook (`.claude/extensions/md-log.mjs`) before it reaches you. If you are reading this, that hook did not run, so nothing was linked.

Tell the user, in one or two sentences, that `/md-log` is not active in this session: the md-log hooks in `.claude/settings.json` aren't loaded (the learning system must live in the project's `.claude/` folder, and `npm install` must have been run in `.claude/extensions`). Do nothing else.
