---
name: stop
description: Stop the Gandalf stack — pause (fast resume), remove containers, or full reset.
argument-hint: "[DOWN=true] [CLEAN=true]"
allowed-tools: Bash
---

User input: $ARGUMENTS

Three levels, mapped straight to the CLI. Pick based on the user's intent and pass
the flag through verbatim:

- (no flag) — pause containers in place; next `/gandalf:start` resumes in seconds.
  This is the safe default and preserves all workflow data.
- `DOWN=true` — remove containers + networks, keep volumes (Temporal DB survives).
- `CLEAN=true` — remove containers, networks, AND volumes. **Full reset — workflow
  history and resume state are lost.** Confirm with the user before running this one.

```bash
cd "${CLAUDE_PLUGIN_ROOT}/.." && ./gandalf stop <FLAG>
```

If the user just says "stop" with no qualifier, use the default pause — do not
escalate to `CLEAN=true` on your own.
