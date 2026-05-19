# CLAUDE.md

AI-powered penetration testing agent for defensive security analysis. Automates vulnerability assessment by combining reconnaissance tools with AI-powered code analysis.

## Commands

**Prerequisites:** Docker, Anthropic API key in `.env`

```bash
# Setup
cp .env.example .env && edit .env  # Set ANTHROPIC_API_KEY

# Prepare input docs (REPO is a folder name inside ./repos/, not an absolute path).
# For graybox/DAST runs, this folder holds read-only project documentation — NOT source code.
# Required layout (preflight enforces docs/ for graybox/mobile/api, src/ for whitebox):
#   ./repos/my-repo/docs/         — project overview, architecture, user flows (REQUIRED for graybox/mobile/api; optional context for whitebox)
#   ./repos/my-repo/src/          — read-only source tree (REQUIRED for whitebox; optional context for other modes)
#   ./repos/my-repo/schemas/      — OpenAPI / GraphQL specs (optional)
#   ./repos/my-repo/api/          — endpoint documentation (optional)
#   ./repos/my-repo/auth/         — role matrix / permission model (optional)
#   ./repos/my-repo/remediation/  — DevOps fix claims to re-verify next run (optional; markdown tables — see prompts/shared/_remediation-verification.txt)
mkdir -p ./repos/my-repo/docs && cp <your-docs>/*.md ./repos/my-repo/docs/
# Whitebox: also populate ./repos/my-repo/src/ with the read-only source tree (e.g. `cp -R <your-src>/* ./repos/my-repo/src/`)

# Run
./shannon start URL=<url> REPO=my-repo
./shannon start URL=<url> REPO=my-repo CONFIG=./configs/my-config.yaml

# Workspaces & Resume
./shannon start URL=<url> REPO=my-repo WORKSPACE=my-audit    # New named workspace
./shannon start URL=<url> REPO=my-repo WORKSPACE=my-audit    # Resume (same command)
./shannon start URL=<url> REPO=my-repo WORKSPACE=<auto-name> # Resume auto-named run
./shannon workspaces                                          # List all workspaces

# Monitor
./shannon logs                      # Real-time worker logs
# Temporal Web UI: http://localhost:8233

# Stop
./shannon stop                      # Preserves workflow data
./shannon stop CLEAN=true           # Full cleanup including volumes

# Build
npm run build
```

**Options:** `CONFIG=<file>` (YAML config), `OUTPUT=<path>` (default: `./audit-logs/`), `WORKSPACE=<name>` (named workspace; auto-resumes if exists), `PIPELINE_TESTING=true` (minimal prompts, 10s retries), `REBUILD=true` (force Docker rebuild), `ROUTER=true` (multi-model routing via [claude-code-router](https://github.com/musistudio/claude-code-router))

## Architecture

### Core Modules
- `src/session-manager.ts` — Agent definitions (`AGENTS` record). Agent types in `src/types/agents.ts`
- `src/config-parser.ts` — YAML config parsing with JSON Schema validation
- `src/ai/claude-executor.ts` — Claude Agent SDK integration with retry logic
- `src/services/` — Business logic layer (Temporal-agnostic). Activities delegate here. Key: `agent-execution.ts`, `error-handling.ts`, `container.ts`
- `src/types/` — Consolidated types: `Result<T,E>`, `ErrorCode`, `AgentName`, `ActivityLogger`, etc.
- `src/utils/` — Shared utilities (file I/O, formatting, concurrency)

### Temporal Orchestration
Durable workflow orchestration with crash recovery, queryable progress, intelligent retry, and parallel execution (5 concurrent agents in vuln/exploit phases).

- `src/temporal/workflows.ts` — Main workflow (`pentestPipelineWorkflow`)
- `src/temporal/activities.ts` — Thin wrappers — heartbeat loop, error classification, container lifecycle. Business logic delegated to `src/services/`
- `src/temporal/activity-logger.ts` — `TemporalActivityLogger` implementation of `ActivityLogger` interface
- `src/temporal/summary-mapper.ts` — Maps `PipelineSummary` to `WorkflowSummary`
- `src/temporal/worker.ts` — Worker entry point
- `src/temporal/client.ts` — CLI client for starting workflows
- `src/temporal/shared.ts` — Types, interfaces, query definitions
### Input Docs Folder (`./repos/<name>/`)

Shannon treats `./repos/<name>/` as **read-only project documentation** — not source code. It is the agent's grounding material: overview, architecture, user flows, API specs, role matrix.

Preflight (`src/services/preflight.ts`) fails fast if `./repos/<name>/docs/` is missing or empty. Optional subfolders (`schemas/`, `api/`, `auth/`, `remediation/`) are not required but surfaced to agents when present. The `_project-docs.txt` shared partial (`prompts/shared/_project-docs.txt`) instructs agents to explore `{{REPO_PATH}}/` with Bash/Read and warns them not to write there.

`remediation/` is consumed exclusively by the `report` agent: each markdown table inside lists prior-run findings that DevOps believes are fixed, the report agent re-tests every claim and renders the verdict into the final report. Schema and re-probe templates live in `prompts/shared/_remediation-verification.txt`. Folder absent or empty → no verification section is rendered (run behaves as a first-round assessment).

### Pipelines

**Graybox Pipelines (default for all runs)** — No source code access. Dynamic DAST via browser/mobile/API probing.

- **Web graybox** (agent prefix: none / `graybox-*`): discovery → auth-mapper → vuln×5 → exploit×5 → graybox-report. Prompts under `prompts/graybox/`.
- **Mobile graybox** (agent prefix: `mobile-*`): mobile-discovery → mobile-auth-mapper → vuln×5 → exploit×5 → mobile-report. Prompts under `prompts/mobile/`.
- **API graybox** (agent prefix: `api-*`): api-discovery → api-auth-mapper → vuln×5 → exploit×5 → api-report. Prompts under `prompts/api/`.

Each tier: 2 discovery phases, 5 parallel vuln analysis agents, 5 parallel exploit agents (conditional on non-empty exploitation queue), and a report agent. Agent sets live in `src/types/agents.ts` as `GRAYBOX_AGENTS`, `MOBILE_GRAYBOX_AGENTS`, `API_GRAYBOX_AGENTS`.

**Whitebox** (`pipeline.mode: whitebox`) — Source-code analysis. Prompts (`prompts/pre-recon-code.txt`, `recon.txt`, `vuln-*.txt`, `exploit-*.txt`, `report-executive.txt`) and the `WHITEBOX_AGENTS` set run against `{{SRC_PATH}} = {repoPath}/src/` (read-only). Phase sequence: pre-recon → recon → vuln×5 → exploit×5 → report. These prompts also serve as the **gold-standard reference** for methodology/proof-obligation/evidence-quality sections in the graybox tiers.

### Supporting Systems
- **Configuration** — YAML configs in `configs/` with JSON Schema validation (`config-schema.json`). Supports auth settings, MFA/TOTP, and per-app testing parameters
- **Prompts** — Per-phase templates in `prompts/` with variable substitution (`{{TARGET_URL}}`, `{{CONFIG_CONTEXT}}`). Shared partials in `prompts/shared/` via `src/services/prompt-manager.ts`
- **SDK Integration** — Uses `@anthropic-ai/claude-agent-sdk` with `maxTurns: 10_000` and `bypassPermissions` mode. Playwright MCP for browser automation, TOTP generation via MCP tool. Login flow template at `prompts/shared/login-instructions.txt` supports form, SSO, API, and basic auth
- **Audit System** — Crash-safe append-only logging in `audit-logs/{hostname}_{sessionId}/`. Tracks session metrics, per-agent logs, prompts, and deliverables. WorkflowLogger (`audit/workflow-logger.ts`) provides unified human-readable per-workflow logs, backed by LogStream (`audit/log-stream.ts`) shared stream primitive
- **Deliverables** — Currently saved to `deliverables/` under the target repo/workspace via the `save_deliverable` MCP tool. Planned move: `./audit-logs/<workspace>/deliverables/` so `./repos/<name>/` stays input-only (see follow-up work in `/Users/elinguyen/.claude/plans/mutable-cuddling-oasis.md`).
- **Workspaces & Resume** — Named workspaces via `WORKSPACE=<name>` or auto-named from URL+timestamp. Resume passes `--workspace` to the Temporal client (`src/temporal/client.ts`), which loads `session.json` to detect completed agents. `loadResumeState()` in `src/temporal/activities.ts` validates deliverable existence, restores git checkpoints, and cleans up incomplete deliverables. Workspace listing via `src/temporal/workspaces.ts`

## Development Notes

### Adding a New Agent
1. Define agent in `src/session-manager.ts` (add to `AGENTS` record). `ALL_AGENTS`/`AgentName` types live in `src/types/agents.ts`
2. Create prompt template in `prompts/` (e.g., `vuln-newtype.txt`)
3. Two-layer pattern: add a thin activity wrapper in `src/temporal/activities.ts` (heartbeat + error classification). `AgentExecutionService` in `src/services/agent-execution.ts` handles the agent lifecycle automatically via the `AGENTS` registry
4. Register activity in `src/temporal/workflows.ts` within the appropriate phase

### Modifying Prompts
- Variable substitution: `{{TARGET_URL}}`, `{{CONFIG_CONTEXT}}`, `{{LOGIN_INSTRUCTIONS}}`
- Shared partials in `prompts/shared/` included via `src/services/prompt-manager.ts`
- Test with `PIPELINE_TESTING=true` for fast iteration

### Key Design Patterns
- **Configuration-Driven** — YAML configs with JSON Schema validation
- **Progressive Analysis** — Each phase builds on previous results
- **SDK-First** — Claude Agent SDK handles autonomous analysis
- **Modular Error Handling** — `ErrorCode` enum, `Result<T,E>` for explicit error propagation, automatic retry (3 attempts per agent)
- **Services Boundary** — Activities are thin Temporal wrappers; `src/services/` owns business logic, accepts `ActivityLogger`, returns `Result<T,E>`. No Temporal imports in services
- **DI Container** — Per-workflow in `src/services/container.ts`. `AuditSession` excluded (parallel safety)

### Security
Defensive security tool only. Use only on systems you own or have explicit permission to test.

## Code Style Guidelines

### Clarity Over Brevity
- Optimize for readability, not line count — three clear lines beat one dense expression
- Use descriptive names that convey intent
- Prefer explicit logic over clever one-liners

### Structure
- Keep functions focused on a single responsibility
- Use early returns and guard clauses instead of deep nesting
- Never use nested ternary operators — use if/else or switch
- Extract complex conditions into well-named boolean variables

### TypeScript Conventions
- Use `function` keyword for top-level functions (not arrow functions)
- Explicit return type annotations on exported/top-level functions
- Prefer `readonly` for data that shouldn't be mutated
- `exactOptionalPropertyTypes` is enabled — use spread for optional props, not direct `undefined` assignment

### Avoid
- Combining multiple concerns into a single function to "save lines"
- Dense callback chains when sequential logic is clearer
- Sacrificing readability for DRY — some repetition is fine if clearer
- Abstractions for one-time operations
- Backwards-compatibility shims, deprecated wrappers, or re-exports for removed code — delete the old code, don't preserve it

### Comments
Comments must be **timeless** — no references to this conversation, refactoring history, or the AI.

**Patterns used in this codebase:**
- `/** JSDoc */` — file headers (after license) and exported functions/interfaces
- `// N. Description` — numbered sequential steps inside function bodies. Use when a
  function has 3+ distinct phases where at least one isn't immediately obvious from the
  code. Each step marks the start of a logical phase. Reference: `AgentExecutionService.execute`
  (steps 1-9) and `injectModelIntoReport` (steps 1-5)
- `// === Section ===` — high-level dividers between groups of functions in long files,
  or to label major branching/classification blocks (e.g., `// === SPENDING CAP SAFEGUARD ===`).
  Not for sequential steps inside function bodies — use numbered steps for that
- `// NOTE:` / `// WARNING:` / `// IMPORTANT:` — gotchas and constraints

**Never:** obvious comments, conversation references ("as discussed"), history ("moved from X")

## Key Files

**Entry Points:** `src/temporal/workflows.ts`, `src/temporal/activities.ts`, `src/temporal/worker.ts`, `src/temporal/client.ts`

**Core Logic:** `src/session-manager.ts`, `src/ai/claude-executor.ts`, `src/config-parser.ts`, `src/services/`, `src/audit/`

**Config:** `shannon` (CLI), `docker-compose.yml`, `configs/`, `prompts/`

## Troubleshooting

- **"Input path does not exist"** / **"Input docs folder missing or empty"** — `REPO` must be a folder name inside `./repos/`, not an absolute path. The folder must contain a non-empty `docs/` subfolder: `mkdir -p ./repos/my-repo/docs && cp <your-docs>/*.md ./repos/my-repo/docs/`.
- **"Temporal not ready"** — Wait for health check or `docker compose logs temporal`
- **Worker not processing** — Check `docker compose ps`
- **Reset state** — `./shannon stop CLEAN=true`
- **Local apps unreachable** — Use `host.docker.internal` instead of `localhost`
- **Missing tools** — Use `PIPELINE_TESTING=true` to skip nmap/subfinder/whatweb (graceful degradation)
- **Container permissions** — On Linux, may need `sudo` for docker commands
