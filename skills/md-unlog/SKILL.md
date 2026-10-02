---
name: md-unlog
description: Stop mirroring the session to a markdown file
disable-model-invocation: true
---

The `/md-unlog` command is handled by the md-log hook (`.claude/extensions/md-log.mjs`) before it reaches you. If you are reading this, that hook did not run.

Tell the user, in one sentence, that md-log is not active in this session (the md-log hooks in `.claude/settings.json` aren't loaded), so there is nothing to unlink. Do nothing else.
