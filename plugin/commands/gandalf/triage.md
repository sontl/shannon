---
name: triage
description: Read a finished run's deliverables and triage findings — rank by real exploitability, flag likely false positives, propose next probes.
argument-hint: "[WORKSPACE=<name>] [AXIS=<auth|authz|injection|ssrf|xss|...>]"
allowed-tools: Bash, Read
---

User input: $ARGUMENTS

This command adds reasoning the CLI does not provide: it triages what a Gandalf run
already produced. Deliverables live at
`${CLAUDE_PLUGIN_ROOT}/../audit-logs/<workspace>/deliverables/`.

NOTE: this reasoning runs in the user's Claude Code session, so token cost lands on
the user's account — not the Gandalf API key. Read the small structured files first
and only pull a large report excerpt when a finding genuinely needs it.

## Steps

1. Resolve the workspace:
   - If `WORKSPACE=<name>` is given, use it.
   - Otherwise pick the most recently modified workspace under `audit-logs/` that has
     a non-empty `deliverables/`. State which one you chose.

   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}/.." && ls -td audit-logs/*/deliverables 2>/dev/null | head
   ```

2. Read the structured signals first (cheapest, highest signal). If `AXIS=` is set,
   restrict to that axis; otherwise cover all axes present:
   - `*_exploitation_queue.json` — candidate findings the agents queued.
   - `*_exploitation_evidence.md` — what was actually demonstrated (real PoC vs theory).
   - `*_analysis_deliverable.md` — the vuln-analysis rationale per axis.
   Only open `final_report.md` for a specific finding's full write-up when needed —
   do not slurp the whole 100KB+ report by default.

3. Triage each finding into a ranked table:
   - **Confirmed-exploitable** — evidence file shows a working PoC / concrete impact.
   - **Plausible-unproven** — queued/analyzed but no demonstrated exploitation.
   - **Likely false positive** — evidence weak, contradicts auth map, or self-refuted.
   Sort by real-world exploitability (impact × demonstrated reliability), not by the
   agent's stated severity alone.

4. For the top items, propose a concrete next probe (what to test, against which
   endpoint/role) — framed as input the operator could feed back into another run.

5. Be faithful: only triage findings the files actually contain. If evidence is thin,
   say so explicitly rather than inflating confidence. Print the workspace path you read.
