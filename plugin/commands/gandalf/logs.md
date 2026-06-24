---
name: logs
description: Tail the human-readable workflow log for a running or finished Gandalf run.
argument-hint: "ID=<workflow-id>"
allowed-tools: Bash
---

User input: $ARGUMENTS

1. The CLI requires `ID=<workflow-id>`. If the user did not provide it, run
   `/gandalf:status` first to help them find it (or ask), then stop.
2. Tail the log from the framework root:

   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}/.." && ./gandalf logs ID=<workflow-id>
   ```

   Note: this follows the log (`tail -f`) and runs until interrupted. If the user
   just wants a snapshot, read the file directly instead:
   `${CLAUDE_PLUGIN_ROOT}/../audit-logs/<workspace>/workflow.log`.
3. Relay the relevant lines. Do not summarize away errors — surface them verbatim.
