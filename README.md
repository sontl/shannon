# Gandalf

AI-powered penetration testing framework for TECHVIFY internal security audits. Web, mobile, API, network, and whitebox source-code pipelines in a single CLI — Temporal-orchestrated, durable, with multi-persona and remediation-verification support.

> Licensed under AGPL-3.0. Attribution and modification history in [NOTICE.md](./NOTICE.md).

---

## Table of Contents

- [Quick Start](#quick-start)
- [Pipelines](#pipelines)
- [Mode Usage](#mode-usage)
- [Workspaces & Resume](#workspaces--resume)
- [Multi-Persona Testing](#multi-persona-testing)
- [Remediation Verification](#remediation-verification)
- [Configuration](#configuration)
- [Provider Options](#provider-options)
- [CLI Reference](#cli-reference)
- [Monitoring](#monitoring)
- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [License](#license)

---

## Quick Start

**Prerequisites:** Docker, an Anthropic API key (or Bedrock / Vertex / router credentials), and a target documentation folder under `./repos/`.

```bash
# 1. Configure credentials
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY=sk-... and (recommended) CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000

# 2. Prepare target docs (REQUIRED for every run — REPO is a folder name under ./repos/)
mkdir -p ./repos/my-target/docs
cp /path/to/spec/*.md ./repos/my-target/docs/
# For whitebox runs, also populate ./repos/my-target/src/ with the read-only source tree

# 3. Run
./gandalf start URL=https://target.example.com REPO=my-target
```

That's it. Gandalf builds the worker container, starts the workflow on Temporal, and streams progress. Monitor at `http://localhost:8233` or with `./gandalf logs`.

---

## Pipelines

Five pipeline tiers. The right one for a given engagement depends on what the target gives you access to.

| Tier | Activation | Agents | Use when… |
|---|---|---|---|
| **Web graybox** (default) | No config flag (default) | 13 | Web app, no source. Browser-driven DAST via Playwright MCP. |
| **Mobile graybox** | `APP=` flag or config has mobile block | 13 | Native iOS/Android app via Appium + emulator/device. |
| **API graybox** | Config: `pipeline.target: api` | 13 | Pure HTTP API, no browser. Schema-driven via Bash + curl + jq. |
| **Network graybox (v1)** | Config: `pipeline.target: network` | 15 | Internal network / AD environment. nmap, NetExec, impacket, BloodHound. |
| **Whitebox** | Config: `pipeline.mode: whitebox` | 13 | You have source access. Code-aware DAST against running app. |

Each tier follows the same skeleton — discovery → auth-mapper → 5 parallel vuln agents → 5 parallel exploit agents → report — except network which adds a sequential enumeration phase and a post-exploit simulation phase (15 agents total).

---

## Mode Usage

### Web graybox

```bash
./gandalf start URL=https://app.example.com REPO=my-target CONFIG=./configs/web.yaml
```

`CONFIG` is optional. Use it to provide login credentials, TOTP secrets, multi-persona setups, or rules (avoid/focus paths).

### Mobile graybox

Requires Appium running on host:

```bash
# Terminal 1 — Appium
export ANDROID_HOME=~/Library/Android/sdk
appium --port 4723

# Terminal 2 — Gandalf
./gandalf start APP=com.example.app DEVICE=emulator-5554 REPO=my-target CONFIG=./configs/mobile.yaml
```

Pass `APK=/path/to/app.apk` if the app is not installed on the emulator.

### API graybox

```bash
./gandalf start URL=https://api.example.com REPO=my-target CONFIG=./configs/api.yaml
```

Set `pipeline.target: api` in the config. Drop OpenAPI/Swagger/GraphQL schemas under `./repos/my-target/schemas/` — the discovery agent ingests them automatically.

### Network graybox

```bash
./gandalf start REPO=my-target CONFIG=./configs/network.yaml
```

No `URL=` needed — addressing comes from `pipeline.network.scope.targets` in the config. Cloud assets are explicitly out of scope for this tier (deferred to a future `cloud-graybox`).

Sidecar profiles (gated by `docker-compose.yml` profiles):
- `ad` — BloodHound CE + Neo4j + PostgreSQL for AD graph queries
- `vuln-scan` — OpenVAS / GVM
- `relay` — Responder + mitm6 + ntlmrelayx (RoE-gated via `pipeline.network.relay.enabled`, requires `network_mode: host`)

### Whitebox

```bash
./gandalf start URL=http://host.docker.internal:4000 REPO=my-target CONFIG=./configs/whitebox.yaml
```

Set `pipeline.mode: whitebox`. Populate `./repos/my-target/src/` with the read-only source tree. Agents read source directly to guide attack strategy, then validate against the running app.

---

## Workspaces & Resume

Every run lives in a workspace under `./audit-logs/`. Auto-named by default (e.g. `app-example-com_gandalf-1771007534808`), or pass `WORKSPACE=<name>` for a custom name.

```bash
# Named workspace
./gandalf start URL=... REPO=... WORKSPACE=q1-audit

# Resume — same command. Gandalf detects completed agents from session.json
# and picks up where it left off. Failed agents retry up to 3 times.
./gandalf start URL=... REPO=... WORKSPACE=q1-audit

# List all workspaces with status, duration, cost
./gandalf workspaces
```

Resume requires the original URL to match (cross-target contamination guard). Each agent is git-checkpointed, so resumed runs restart from a clean validated state.

---

## Multi-Persona Testing

Test cross-role IDOR + vertical privilege escalation in a single workflow. Discovery runs once (shared); auth-mapper + vuln/exploit run once per persona in parallel; the authz exploit agent reads every persona's token bundle to test cross-role boundaries.

```yaml
authentication:
  login_type: form
  login_url: https://app.example.com/login
  login_flow:
    - "Type $username into the email field"
    - "Type $password into the password field"
    - "Click 'Sign In'"
  success_condition: { type: url_contains, value: "/dashboard" }
  personas:
    - { name: admin,  role: administrator, credentials: { username: admin@x.com,  password: ... } }
    - { name: viewer, role: read-only,     credentials: { username: viewer@x.com, password: ... } }
```

Cost trade-off: 2 personas ≈ 1.5–2× a single-persona run. The payoff is detecting a class of authz bugs that a single-persona run literally cannot find.

Configs that still use a single `authentication.credentials` block auto-migrate to a `default` persona at load time. No edits needed for existing YAML.

---

## Remediation Verification

After DevOps claims to have fixed findings from a prior run, drop the fix claims under `./repos/<name>/remediation/` as markdown tables (schema in `prompts/shared/_remediation-verification.txt`). The `report` agent re-tests every claim and renders the verdict — `Verified Fixed`, `Still Vulnerable`, `Partially Fixed`, or `Inconclusive` — into the final report.

Folder absent or empty → no verification section is rendered (run behaves as a first-round assessment).

---

## Configuration

YAML configs in `./configs/` are JSON Schema-validated (`configs/config-schema.json`).

```yaml
pipeline:
  mode: graybox          # graybox | whitebox
  target: web            # web | mobile | api | network
  retry_preset: default  # default | subscription (extends backoff for Anthropic Pro/Max plans)
  max_concurrent_pipelines: 5   # 1-5, default 5

authentication:
  login_type: form       # form | sso | api | basic
  login_url: https://app.example.com/login
  credentials:
    username: test@example.com
    password: ...
    totp_secret: LB2E2RX7XFHSTGCK   # optional — 2FA handled automatically
  login_flow:
    - "Type $username into the email field"
    - "Type $password into the password field"
    - "Click the 'Sign In' button"
  success_condition:
    type: url_contains
    value: "/dashboard"

rules:
  avoid:
    - { description: "Skip logout link", type: path, url_path: "/logout" }
  focus:
    - { description: "Emphasize API endpoints", type: path, url_path: "/api" }
```

See `./configs/*.yaml` for full working examples covering every mode.

---

## Provider Options

Default is Anthropic API. Alternatives are toggled via `.env`:

| Provider | Env flag | Required vars |
|---|---|---|
| **Anthropic API** (default) | — | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| **AWS Bedrock** | `CLAUDE_CODE_USE_BEDROCK=1` | `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_{SMALL,MEDIUM,LARGE}_MODEL` |
| **Google Vertex AI** | `CLAUDE_CODE_USE_VERTEX=1` | `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, model vars |
| **Custom base URL** | — | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` |
| **Router (experimental)** | `ROUTER=true` (CLI flag) | `OPENAI_API_KEY` or `OPENROUTER_API_KEY`, `ROUTER_DEFAULT=openai,gpt-5.2` |

Three model tiers used internally: `small` (haiku, summarization), `medium` (sonnet, security analysis), `large` (opus, deep reasoning).

---

## CLI Reference

```
./gandalf start [URL=<url>] [APP=<bundle>] REPO=<name> [CONFIG=<path>] [...]   Start a workflow
./gandalf logs ID=<workflow-id>                                                Tail workflow logs
./gandalf workspaces                                                           List all workspaces
./gandalf trace [WORKSPACE=<name>] [PERSONA=<p>] [AGENT=<a>]                   Open Playwright trace viewer
./gandalf stop [CLEAN=true]                                                    Stop containers (CLEAN=true removes volumes)
./gandalf help                                                                 Show help
```

### `start` options

| Option | Description |
|---|---|
| `REPO=<name>` | **Required.** Folder under `./repos/` with target docs (`docs/`) and optional `src/`, `schemas/`, `api/`, `auth/`, `remediation/` |
| `URL=<url>` | Target URL (web / API). Optional for mobile (use `APP=`) and network (scope comes from config) |
| `APP=<id>` | Mobile bundle ID / package name |
| `DEVICE=<id>` | Mobile device or emulator ID (`adb devices`) |
| `APK=<path>` | Path to APK/IPA to install before testing |
| `CONFIG=<path>` | YAML config (auth, rules, pipeline mode/target) |
| `WORKSPACE=<name>` | Named workspace — auto-resumes if exists |
| `OUTPUT=<path>` | Custom output directory (default: `./audit-logs/`) |
| `PIPELINE_TESTING=true` | Use minimal prompts + 10s retries for fast iteration |
| `REBUILD=true` | Force `docker compose build --no-cache` before run |
| `ROUTER=true` | Route through claude-code-router for multi-model support |

---

## Monitoring

```bash
./gandalf logs                                      # Real-time worker logs
./gandalf logs ID=app-example-com_gandalf-...       # Tail a specific workflow's log
open http://localhost:8233                          # Temporal Web UI (workflow tree, history, queries)
```

### Trace viewer (web pipelines)

Playwright records traces under `audit-logs/<workspace>/.runtime/traces/<persona>/`. Open them with the viewer:

```bash
./gandalf trace                                                # Most recent workspace, most recent trace
./gandalf trace WORKSPACE=<name> LIST=true                     # List all traces chronologically, by owning agent
./gandalf trace WORKSPACE=<name> INDEX=3                       # Open the 3rd trace
./gandalf trace WORKSPACE=<name> AGENT=xss-exploit             # Filter to traces produced while xss-exploit was active
./gandalf trace WORKSPACE=<name> AGENT=xss-exploit EVIDENCE=true   # Skip viewer; print trace zip + agent log + deliverable paths
```

---

## Architecture

Multi-agent system on top of Anthropic's Claude Agent SDK, orchestrated by Temporal for durability and parallel execution.

```
                ┌──────────────────────┐
                │  Discovery / Recon   │
                └──────────┬───────────┘
                           ▼
                ┌──────────────────────┐
                │     Auth Mapper      │   (graybox tiers)
                └──────────┬───────────┘
                           ▼
        ┌──────────┬───────┴────────┬──────────┐
        ▼          ▼                ▼          ▼
    ┌─────────┐ ┌─────────┐    ┌─────────┐ ┌─────────┐
    │  Vuln   │ │  Vuln   │ … │  Vuln   │   5 parallel
    │  Inj    │ │  XSS    │    │  Authz  │   agents
    └────┬────┘ └────┬────┘    └────┬────┘
         ▼           ▼              ▼
    ┌─────────┐ ┌─────────┐    ┌─────────┐
    │ Exploit │ │ Exploit │ … │ Exploit │   5 parallel,
    │  Inj    │ │  XSS    │    │  Authz  │   pipelined per pair
    └────┬────┘ └────┬────┘    └────┬────┘
         └───────────┴──────────────┘
                     ▼
                ┌──────────┐
                │  Report  │
                └──────────┘
```

Each pair runs independently — the XSS exploit agent starts as soon as the XSS vuln agent finishes, even while the injection vuln agent is still running. No barrier.

### Core modules

| Module | Role |
|---|---|
| `src/temporal/workflows.ts` | Pipeline orchestrator (`pentestPipelineWorkflow`) |
| `src/temporal/activities.ts` | Thin activity wrappers — heartbeat, error classification |
| `src/services/` | Business logic — Temporal-agnostic, returns `Result<T, E>` |
| `src/ai/claude-executor.ts` | SDK integration — MCP servers, message stream, retry |
| `src/session-manager.ts` | Agent registry (`AGENTS`) and MCP mapping |
| `src/audit/` | Crash-safe append-only logging + metrics |
| `mcp-server/` | In-process MCP servers — `gandalf-helper` + Appium tools |
| `prompts/` | Per-phase prompt templates + shared partials |
| `configs/` | YAML configs + JSON schema |

### MCP servers per agent

| Agent prefix | MCP server | Tools |
|---|---|---|
| Web (no prefix / `graybox-*`) | `gandalf-helper` + Playwright MCP | Browser automation |
| Mobile (`mobile-*`) | `gandalf-helper` + Appium MCP | `appium_tap`, `appium_type`, `appium_swipe`, `appium_screenshot`, `appium_hierarchy`, `appium_back`, `appium_launch_app` |
| API (`api-*`) | `gandalf-helper` only | Bash + curl + jq |
| Network (`network-*`) | `gandalf-helper` only | Native CLI: nmap, NetExec, impacket, certipy, hashcat |

`gandalf-helper` always-present tools: `save_deliverable`, `generate_totp`.

---

## Repository Layout

```
.
├── gandalf                  # CLI entrypoint
├── docker-compose.yml       # Worker + Temporal + optional sidecars
├── Dockerfile               # Worker container
├── configs/                 # YAML configs + JSON schema
├── prompts/                 # Per-phase prompt templates
│   ├── graybox/             # Web graybox prompts
│   ├── mobile/              # Mobile graybox prompts
│   ├── api/                 # API graybox prompts
│   ├── network/             # Network graybox prompts
│   ├── shared/              # Shared partials (login, project-docs, etc.)
│   ├── pre-recon-code.txt   # Whitebox prompts
│   ├── recon.txt
│   ├── vuln-*.txt
│   ├── exploit-*.txt
│   └── report-executive.txt
├── repos/                   # Target inputs (one folder per engagement)
│   └── <name>/
│       ├── docs/            # REQUIRED — project overview, architecture, user flows
│       ├── src/             # REQUIRED for whitebox — read-only source tree
│       ├── schemas/         # Optional — OpenAPI / GraphQL specs
│       ├── api/             # Optional — endpoint documentation
│       ├── auth/            # Optional — role matrix / permission model
│       └── remediation/     # Optional — DevOps fix claims to re-verify
├── audit-logs/              # Workspaces (output) — one folder per workflow run
├── src/                     # TypeScript source
├── mcp-server/              # gandalf-helper + Appium MCP
└── audit-viewer/            # Optional Next.js viewer for audit logs (dev tool)
```

`./repos/<name>/` is **read-only input documentation**. Agents read it for grounding but never write back. All output goes to `./audit-logs/<workspace>/`.

---

## Development

### Adding a new agent

1. Define agent in `src/session-manager.ts` (add to `AGENTS` record). Add to `AgentName` type in `src/types/agents.ts`.
2. Create prompt template in `prompts/` (e.g. `prompts/graybox/vuln-newtype.txt`).
3. Add a thin activity wrapper in `src/temporal/activities.ts` (heartbeat + error classification). `AgentExecutionService` handles the agent lifecycle automatically.
4. Register the activity in `src/temporal/workflows.ts` within the appropriate phase.

### Modifying prompts

- Variable substitution: `{{TARGET_URL}}`, `{{CONFIG_CONTEXT}}`, `{{LOGIN_INSTRUCTIONS}}`, `{{REPO_PATH}}`.
- Shared partials in `prompts/shared/` included via `src/services/prompt-manager.ts`.
- Iterate fast with `PIPELINE_TESTING=true` — minimal prompts, 10s retries.

### Build

```bash
npm install
cd mcp-server && npm install && npm run build && cd ..
npm run build
```

Docker rebuilds happen automatically on `./gandalf start`. Force a clean rebuild with `REBUILD=true`.

### Key design patterns

- **Services boundary** — Activities are thin Temporal wrappers; `src/services/` owns business logic, accepts `ActivityLogger`, returns `Result<T, PentestError>`. No Temporal imports in services.
- **DI container** — Per-workflow in `src/services/container.ts`. `AuditSession` excluded (parallel safety).
- **Error handling** — `ErrorCode` enum, `Result<T, E>` for explicit propagation, automatic retry (3 attempts per agent).
- **Parallel safety** — `Promise.allSettled` (never `Promise.all`), 2s stagger between parallel starts, mutex on `session.json` writes.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Input docs folder missing or empty` | `REPO` must be a folder name under `./repos/` (not absolute). Must have non-empty `docs/` subfolder. |
| `Temporal not ready` | Wait for health check, or `docker compose logs temporal`. |
| Worker not processing | `docker compose ps` — worker should be `running`. |
| Local app unreachable | Use `host.docker.internal` instead of `localhost` in `URL=`. |
| Stuck workflow / weird state | `./gandalf stop CLEAN=true` removes volumes and starts fresh. |
| Pre-commit hook failures | Fix the underlying issue and create a new commit. Never `--no-verify`. |
| Missing tools (nmap, subfinder) | Use `PIPELINE_TESTING=true` for graceful degradation. |
| Container permission errors | On Linux, may need `sudo` for `docker` commands. |
| Subscription rate-limit exhaustion | Set `pipeline.retry_preset: subscription` (6h max backoff, 100 retries) and `max_concurrent_pipelines: 2`. |

---

## Security

Defensive security tool. Use only on systems TECHVIFY owns or has explicit written authorization to test. Active exploitation can mutate target data — never run against production. Use sandboxed / staging environments.

Like any AI-powered tool that reads source code or scrapes pages, Gandalf is susceptible to prompt injection from content in the target. Validate every finding before acting on it.

---

## License

AGPL-3.0 — see [LICENSE](./LICENSE). This is a derivative work of [Keygraph Shannon Lite](https://github.com/KeygraphHQ/shannon); attribution and modification history in [NOTICE.md](./NOTICE.md).
