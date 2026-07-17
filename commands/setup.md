---
description: Toggle the stop-time review gate (full setup probes land with KMP-12)
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" setup $ARGUMENTS
```

Present the command output to the user verbatim.

Notes:
- Only the review-gate toggles work today; the install/login/runtime probes are a later work item (KMP-12). If the command reports that, relay it and suggest checking `kimi --version` and running `kimi login` in a terminal manually.
- Do not attempt to install anything on the user's behalf.
