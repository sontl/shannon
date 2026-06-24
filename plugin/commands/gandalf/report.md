---
name: report
description: Export a Gandalf report markdown into a branded DOCX (+PDF) via the ./gandalf report builder.
argument-hint: "[<path-to-report.md>] [WORKSPACE=<name>]"
allowed-tools: Bash
---

User input: $ARGUMENTS

Wraps the CLI's `report` verb, a thin pass-through to `scripts/build-report.py`:
it turns a report markdown file into a polished, branded Word document (A4, styled
tables, generated cover page) and a PDF when LibreOffice is available. **No flags —
fixed house format.** The framework lives at `${CLAUDE_PLUGIN_ROOT}/..`.

## Steps

1. Resolve the report markdown path:
   - If the user passed an explicit path, use it verbatim.
   - If they passed `WORKSPACE=<name>`, use
     `audit-logs/<name>/deliverables/final_report.md`.
   - Otherwise pick the most recently modified `final_report.md` under
     `audit-logs/*/deliverables/`, and state which one you chose:
     ```bash
     cd "${CLAUDE_PLUGIN_ROOT}/.." && ls -t audit-logs/*/deliverables/final_report.md 2>/dev/null | head
     ```

2. Build it from the framework root (pass the path as a single positional, no flags):
   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}/.." && ./gandalf report <path-to-report.md>
   ```

3. Output is written beside the input as `<workflow>_final_report.docx` (+ `.pdf`
   when LibreOffice is installed). Surface the absolute output path(s) to the user.

4. If the build fails on a missing dependency, relay the CLI's own hint — prereqs are
   `pandoc` + `python-docx` (`python3 -m pip install python-docx`), and PDF
   additionally needs LibreOffice (`brew install --cask libreoffice`). Do not try to
   reimplement the conversion yourself.
