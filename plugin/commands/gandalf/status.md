---
name: status
description: List all Gandalf workspaces and their resume state.
argument-hint: ""
allowed-tools: Bash
---

Show the user every Gandalf workspace (named runs + auto-named runs) and which
agents have completed, so they can decide what to resume.

Run from the framework root:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/.." && ./gandalf workspaces
```

Relay the output. If the user then wants to resume a workspace, point them at
`/gandalf:start … WORKSPACE=<name>` (re-running start with the same workspace name
auto-resumes). Do not invent workspace names — only reference ones the CLI listed.
