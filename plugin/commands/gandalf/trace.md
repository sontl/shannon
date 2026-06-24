---
name: trace
description: Open or list Playwright traces from a web pentest run (evidence trail per agent/persona).
argument-hint: "[WORKSPACE=<name>] [PERSONA=<p>] [AGENT=<name>] [LIST=true] [INDEX=<n>] [EVIDENCE=true]"
allowed-tools: Bash
---

User input: $ARGUMENTS

Traces are only produced by web pentests (Playwright MCP). Pass the CLI options
through verbatim. Valid keys: `WORKSPACE, PERSONA, AGENT, LIST, TRACE, INDEX, EVIDENCE`.

Run from the framework root:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/.." && ./gandalf trace <KEY=VALUE ...>
```

Guidance:
- With no args, the CLI opens the most recent trace in the viewer.
- For an overview first, suggest `LIST=true` to print the chronological trace table
  (with owning agent + persona), then `INDEX=<n>` to open a specific one.
- `EVIDENCE=true` skips the viewer and prints the trace zip + agent log + deliverable
  paths so reasoning and UI line up.
- The viewer (`playwright show-trace`) is a blocking GUI process; mention that to the
  user before opening it.
