---
name: start
description: Start a Gandalf pentest workflow (web/mobile/api/network/whitebox). Submits a durable Temporal workflow, then points the user at logs.
argument-hint: "URL=<url> REPO=<name> [CONFIG=<path>] [WORKSPACE=<name>] [OUTPUT=<path>] [PIPELINE_TESTING=true]"
allowed-tools: Bash, Read
---

You are launching a Gandalf pentest run. The framework lives one directory above
the plugin root, at `${CLAUDE_PLUGIN_ROOT}/..` (this is the cloned Gandalf repo
that contains `./gandalf`, `docker-compose.yml`, `./repos/`, and `.env`).

User input: $ARGUMENTS

## Steps

1. Parse the user's input into Gandalf CLI args. Pass `KEY=VALUE` pairs through
   **verbatim** — do NOT rename, reorder semantically, or reinterpret them. The
   CLI is the single source of truth. Valid keys:
   `URL, REPO, APP, DEVICE, APK, CONFIG, OUTPUT, WORKSPACE, PIPELINE_TESTING, ROUTER, REBUILD`.

2. `REPO` is required for every run (the folder under `./repos/` holding target
   docs/src). If it is missing, ask the user for it and stop — do not guess.

3. Validate the target shape before running:
   - Web: needs `URL`.
   - Mobile: needs `APP` and `DEVICE` (optionally `APK`).
   - API: needs `URL` and a `CONFIG` whose `pipeline.target` is `api`.
   - Network: needs a `CONFIG` whose `pipeline.target` is `network` (`URL` optional).
   If the shape is ambiguous, ask one clarifying question rather than assuming.

4. Run from the framework root so the CLI's relative paths resolve:

   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}/.." && ./gandalf start <KEY=VALUE ...>
   ```

5. The CLI ensures the Docker/Temporal stack is up, then submits the workflow and
   returns a workflow ID. Surface to the user:
   - the workflow ID,
   - the Temporal Web UI link: http://localhost:8233,
   - that they can follow progress with `/gandalf:logs ID=<id>` and read results
     with `/gandalf:report` once it finishes.

6. Do NOT re-implement any pipeline, agent, or analysis logic here. This command
   only constructs the CLI invocation and reports what it returns.
