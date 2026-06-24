# gandalf-pentest (Claude Code plugin)

Slash commands that wrap the Gandalf pentest CLI. The plugin is a thin UX layer —
the durable Temporal workflow engine, the Docker stack, and all pentest logic run
unchanged in the framework itself. Each command does `cd "$CLAUDE_PLUGIN_ROOT/.." &&
./gandalf …`, so the plugin must live inside a Gandalf checkout (it ships as the
`plugin/` folder of this repo).

## Prerequisites

The plugin only constructs commands — the framework still needs its runtime:

- **Docker** (Compose v2) — Gandalf brings up Temporal + the worker container.
- **`.env`** at the repo root with `ANTHROPIC_API_KEY` (or Bedrock/Vertex/router vars).
  This key pays for the pentest agents — it is separate from the Claude account you
  use Claude Code with. See `.env.example`.
- **For `/gandalf:report`** (DOCX/PDF export): `pandoc` + `python-docx`
  (`python3 -m pip install python-docx`); PDF additionally needs LibreOffice
  (`brew install --cask libreoffice`).

## Install

```bash
/plugin marketplace add <git-url-or-path-of-this-repo>
/plugin install gandalf-pentest@gandalf-marketplace
```

Installing clones the whole Gandalf repo, so `./gandalf` is present at the plugin
root's parent. No path configuration is needed.

## Commands

| Command | Wraps | Purpose |
|---|---|---|
| `/gandalf:start URL=… REPO=…` | `gandalf start` | Submit a pentest workflow (web/mobile/api/network/whitebox) |
| `/gandalf:status` | `gandalf workspaces` | List workspaces + resume state |
| `/gandalf:logs ID=…` | `gandalf logs` | Tail the workflow log |
| `/gandalf:trace …` | `gandalf trace` | Open/list Playwright evidence traces (web runs) |
| `/gandalf:report [path]` | `gandalf report` | Export a report markdown to branded DOCX/PDF |
| `/gandalf:stop [DOWN=\|CLEAN=]` | `gandalf stop` | Pause (default), remove, or full reset |
| `/gandalf:triage [WORKSPACE=…]` | — (reasoning) | Rank findings by real exploitability, flag false positives |
| `/gandalf:diff BASE=… HEAD=…` | — (reasoning) | Compare two runs: fixed / new / persistent |

`REPO=<name>` is required for every `start` — a folder under `./repos/` holding
read-only target docs. See the `gandalf-pentest` skill for tier selection and the
`./repos/<name>/` layout.

## Two billing meters

- **Wrapper commands** (`start/status/logs/trace/report/stop`) just shell out; the
  heavy token cost lands on the Gandalf `.env` key.
- **Reasoning commands** (`triage/diff`) do their analysis inside *your* Claude Code
  session, so that cost lands on *your* Claude account, not the Gandalf key.

## Layout & tests

```
.claude-plugin/marketplace.json   # at the REPO root — source: "./plugin"
plugin/
├── .claude-plugin/plugin.json
├── commands/gandalf/*.md
├── skills/gandalf-pentest/        # tier selection, repos/ layout, config snippets
└── tests/plugin-contract.sh       # static contract test (manifests, frontmatter, seam)
```

Run the contract test (needs `jq`):

```bash
bash plugin/tests/plugin-contract.sh
```

It validates the manifests, every command's frontmatter, and that the
`cd "$CLAUDE_PLUGIN_ROOT/.." && ./gandalf` seam resolves. The end-to-end parity
runbook (needs Docker) is documented at the bottom of that script.
