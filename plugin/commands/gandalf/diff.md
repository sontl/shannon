---
name: diff
description: Compare two Gandalf runs — what's newly found, what's been fixed, what persists. Useful for re-test / regression rounds.
argument-hint: "BASE=<workspace> HEAD=<workspace> [AXIS=<auth|authz|injection|ssrf|xss|...>]"
allowed-tools: Bash, Read
---

User input: $ARGUMENTS

Compare the deliverables of two runs to see how the target's security posture changed
between them (e.g. before vs after a remediation round). Deliverables live at
`${CLAUDE_PLUGIN_ROOT}/../audit-logs/<workspace>/deliverables/`.

NOTE: the comparison reasoning runs in the user's Claude Code session — token cost is
on the user's account, not the Gandalf key.

## Steps

1. Resolve both workspaces:
   - `BASE=` is the earlier / reference run, `HEAD=` is the newer run.
   - If either is missing, list available workspaces and ask which two to compare:
     ```bash
     cd "${CLAUDE_PLUGIN_ROOT}/.." && ls -td audit-logs/*/deliverables 2>/dev/null | head -20
     ```

2. For each axis present in either run (respect `AXIS=` if given), read the structured
   signals from BOTH workspaces — prefer the small files:
   - `*_exploitation_queue.json` and `*_exploitation_evidence.md` for the finding sets.
   - `*_analysis_deliverable.md` for context when a finding's status is ambiguous.
   Match findings across runs by type + endpoint/parameter + affected role, not by
   array position (the agents may order them differently between runs).

3. Produce a three-bucket diff:
   - **Fixed** — present & exploitable in BASE, absent or no-longer-exploitable in HEAD.
   - **New** — present in HEAD, not in BASE.
   - **Persistent** — present in both (note if severity/exploitability changed).
   Show a compact table (axis · finding · BASE status · HEAD status), then a short
   narrative of the net change in posture.

4. Call out anything suspicious: a finding that "disappeared" with no evidence of a fix
   may just be non-determinism between runs — flag it as *unconfirmed-fixed* rather than
   *fixed*, and suggest re-testing it specifically.

5. Be faithful to the files. Print both workspace paths you compared.
