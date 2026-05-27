# NOTICE

This software (**Gandalf**) is a derivative work of **Shannon Lite** by
Keygraph, Inc.

- **Original work** — Shannon Lite
  Copyright (C) 2025 Keygraph, Inc.
  https://github.com/KeygraphHQ/shannon
  Licensed under the GNU Affero General Public License, version 3.

- **This fork** — Gandalf, maintained by TECHVIFY
  Copyright (C) 2026 TECHVIFY (modifications and additions)
  Licensed under the GNU Affero General Public License, version 3.

The full license text is in [LICENSE](./LICENSE). Per AGPL-3.0 Section 5(a),
the principal modifications introduced by this fork are summarized below.
Files inherited from upstream retain the original Keygraph copyright
notice. Files originating in this fork carry a TECHVIFY copyright notice.

---

## Modifications from upstream

| Date       | Author        | Change                                                                                                  |
|------------|---------------|---------------------------------------------------------------------------------------------------------|
| 2026-03-22 | Shaun Tran    | Added bundled `audit-viewer/` web UI for inspecting workflow runs.                                      |
| 2026-03-25 | Shaun Tran    | Scaffolded graybox pipeline testing — new vuln/exploit prompts and example configurations.              |
| 2026-03-26 | Shaun Tran    | Added example dashboard configs; introduced discovery and auth-mapper agent phases.                     |
| 2026-04-21 | eli nguyen    | Added mobile graybox pipeline (Appium MCP, 13 agents) and API-only graybox pipeline (Bash + curl).      |
| 2026-04-23 | eli nguyen    | Refined mobile graybox pipeline for Android runtime (device selection, APK install, env passthrough).   |
| 2026-04-28 | eli nguyen    | Switched `./repos/<name>/` to read-only target documentation; preflight + path separation refactor.     |
| 2026-05-06 | eli nguyen    | Added multi-persona execution: persona-safe parallel runs, idempotent retries, audit-ready reports.     |
| 2026-05-12 | eli nguyen    | Added remediation verification (re-test DevOps fix claims); MCP resilience; persona-aware validators.   |
| 2026-05-19 | eli nguyen    | Added Playwright trace viewer; restored whitebox pipeline; hardened report stitching.                   |
| 2026-05-27 | eli nguyen    | Scaffolded network graybox tier (v1) — 15-agent flow (discovery → enumeration → ... → postex → report). |
| 2026-05-27 | eli nguyen    | Rebranded the project end-to-end: Shannon → Gandalf (CLI, MCP, env vars, task queue, workflow IDs).     |

---

## What stays unchanged from upstream

- Core multi-agent architecture (Anthropic Claude Agent SDK)
- Whitebox pipeline prompts (Phase 1 pre-recon → Phase 5 report)
- Temporal workflow orchestration
- AGPL-3.0 license terms
- Reference benchmarks methodology

---

## Trademarks and naming

"Gandalf" is the product name used by this fork for internal identification
and is not registered as a trademark by TECHVIFY. The name refers to the
fictional character from J. R. R. Tolkien's works and is used here in the
generic, descriptive sense common to security tooling (e.g., a "gatekeeper"
that probes for weaknesses). Users redistributing this software downstream
should make their own assessment of any naming conflicts with third-party
products in the AI-security space (notably Lakera's "Gandalf" prompt
injection demo) before any commercial deployment.

"Shannon" remains the property of Keygraph, Inc. and is not used by this
fork as a product identifier — only as a citation when referencing the
upstream project.

---

## How to comply with AGPL-3.0 when running this software

- Internal use within TECHVIFY or downstream forks: no additional
  obligations beyond preserving this notice and the LICENSE file.
- Distribution (binary or source): include LICENSE, this NOTICE, and any
  files documenting your own modifications.
- Operation as a network service (e.g., SaaS): under AGPL-3.0 Section 13,
  you must offer the complete corresponding source code (including your
  modifications) to every user who interacts with the service over a
  network.
