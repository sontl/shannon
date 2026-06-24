#!/usr/bin/env bash
#
# plugin-contract.sh — static contract test for the gandalf-pentest plugin.
#
# Verifies the deterministic parts of the plugin wrapper: manifests parse and
# cross-reference correctly, every command has valid frontmatter, and the single
# integration seam (`cd "$CLAUDE_PLUGIN_ROOT/.." && ./gandalf …`) actually resolves
# to a runnable CLI. It does NOT — and cannot — verify that Claude maps natural
# language to KEY=VALUE args; that is the model's job and is covered by the manual
# parity runbook at the bottom of this file.
#
# Requires: bash, jq. Run:  bash plugin/tests/plugin-contract.sh
#
set -u

# Resolve layout from this script's location: plugin/tests/ -> plugin/ -> repo root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/.." && pwd)"

PASS=0
FAIL=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required"; exit 2; }

MARKET="$REPO_ROOT/.claude-plugin/marketplace.json"
MANIFEST="$PLUGIN_ROOT/.claude-plugin/plugin.json"

echo "== A. Manifests =="
if jq -e . "$MARKET" >/dev/null 2>&1; then ok "marketplace.json is valid JSON"; else bad "marketplace.json invalid/missing"; fi
if jq -e . "$MANIFEST" >/dev/null 2>&1; then ok "plugin.json is valid JSON"; else bad "plugin.json invalid/missing"; fi

MK_PLUGIN_NAME=$(jq -r '.plugins[0].name // empty' "$MARKET" 2>/dev/null)
MK_SOURCE=$(jq -r '.plugins[0].source // empty' "$MARKET" 2>/dev/null)
PL_NAME=$(jq -r '.name // empty' "$MANIFEST" 2>/dev/null)

[ -n "$(jq -r '.name // empty' "$MARKET")" ] && ok "marketplace has a name" || bad "marketplace missing name"
[ -n "$(jq -r '.version // empty' "$MANIFEST")" ] && ok "plugin has a version" || bad "plugin missing version"
[ "$MK_PLUGIN_NAME" = "$PL_NAME" ] && ok "marketplace plugin name matches plugin.json ($PL_NAME)" \
  || bad "name mismatch: marketplace='$MK_PLUGIN_NAME' plugin.json='$PL_NAME'"
[ "$MK_SOURCE" = "./plugin" ] && ok "marketplace source is ./plugin" || bad "source is '$MK_SOURCE', expected ./plugin"
[ -f "$REPO_ROOT/$MK_SOURCE/.claude-plugin/plugin.json" ] && ok "source path resolves to the plugin" \
  || bad "source '$MK_SOURCE' does not resolve to a plugin manifest"

echo "== B. Command frontmatter =="
for f in "$PLUGIN_ROOT"/commands/gandalf/*.md; do
  [ -e "$f" ] || { bad "no command files found"; break; }
  base="$(basename "$f" .md)"
  # Extract the frontmatter block (between the first two --- lines).
  fm="$(awk 'NR==1 && $0=="---"{f=1;next} f && $0=="---"{exit} f{print}' "$f")"
  name="$(printf '%s\n' "$fm" | sed -n 's/^name:[[:space:]]*//p' | head -1)"
  desc="$(printf '%s\n' "$fm" | sed -n 's/^description:[[:space:]]*//p' | head -1)"
  if [ -z "$fm" ]; then bad "$base: no frontmatter"; continue; fi
  [ -n "$desc" ] && : || bad "$base: missing description"
  if [ "$name" = "$base" ]; then ok "$base: frontmatter name matches filename"; else bad "$base: name='$name' != filename"; fi
done

echo "== C. Integration seam =="
GANDALF="$REPO_ROOT/gandalf"
if [ -x "$GANDALF" ]; then ok "./gandalf exists and is executable at \$CLAUDE_PLUGIN_ROOT/.."; else bad "./gandalf missing or not executable at $GANDALF"; fi
if ( cd "$REPO_ROOT" && ./gandalf help 2>/dev/null | grep -q "Usage" ); then ok "'./gandalf help' runs and prints Usage"; else bad "'./gandalf help' did not run cleanly"; fi

echo "== D. Passthrough pattern (stubbed) =="
# Confirm the documented invocation pattern forwards KEY=VALUE args verbatim, in order.
TMP="$(mktemp -d)"
cat > "$TMP/gandalf" <<'STUB'
#!/usr/bin/env bash
echo "GANDALF_GOT: $*"
STUB
chmod +x "$TMP/gandalf"
GOT="$( cd "$TMP" && ./gandalf start URL=https://x REPO=r WORKSPACE=w )"
if [ "$GOT" = "GANDALF_GOT: start URL=https://x REPO=r WORKSPACE=w" ]; then
  ok "KEY=VALUE args reach the CLI verbatim and in order"
else
  bad "passthrough mismatch: '$GOT'"
fi
rm -rf "$TMP"

echo ""
echo "== Summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1

# ---------------------------------------------------------------------------
# MANUAL parity runbook (needs Docker + a live Claude Code session, not in CI):
#   1.  cd "$REPO_ROOT" && ./gandalf start URL=https://x REPO=r WORKSPACE=direct PIPELINE_TESTING=true
#   2.  /gandalf:start URL=https://x REPO=r WORKSPACE=via-plugin PIPELINE_TESTING=true
#   3.  diff -r audit-logs/direct/deliverables audit-logs/via-plugin/deliverables
#       Expect differences only in timestamps / sessionId — same binary, same output.
# ---------------------------------------------------------------------------
