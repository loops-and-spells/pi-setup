#!/usr/bin/env bash
# Drop-in installer for the pi harness: symlinks harness/ into ~/.pi/agent
# and merges the package list into settings.json. Idempotent — safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
HARNESS="$REPO/harness"

mkdir -p "$AGENT_DIR/agents" "$AGENT_DIR/extensions" "$AGENT_DIR/prompts" "$AGENT_DIR/skills"

# Backups must live OUTSIDE pi's auto-loaded dirs: a backup directory left
# inside extensions/ gets scanned by pi and its tools conflict with the
# installed ones (bit us: subagent.pre-harness).
BACKUP_DIR="$AGENT_DIR/.harness-backup/$(date +%Y%m%d-%H%M%S)"

backup() {
  local dst="$1"
  local rel="${dst#"$AGENT_DIR"/}"
  mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
  mv "$dst" "$BACKUP_DIR/$rel"
  echo "  backed up: $dst -> $BACKUP_DIR/$rel"
}

link() {
  local src="$1" dst="$2"
  if [[ -e "$dst" && ! -L "$dst" ]]; then
    backup "$dst"
  elif [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    return
  fi
  ln -sfn "$src" "$dst"
  echo "  linked: $dst -> $src"
}

# migrate stray in-place backups from older installer versions
while IFS= read -r -d '' stray; do
  backup "$stray"
done < <(find "$AGENT_DIR/extensions" "$AGENT_DIR/agents" "$AGENT_DIR/prompts" \
  -maxdepth 1 -name "*.pre-harness" -print0 2>/dev/null)
if [[ -e "$AGENT_DIR/AGENTS.md.pre-harness" ]]; then
  backup "$AGENT_DIR/AGENTS.md.pre-harness"
fi

echo "Installing pi harness from $HARNESS into $AGENT_DIR"

# Global DOX contract (loaded by pi in every session)
link "$HARNESS/AGENTS.global.md" "$AGENT_DIR/AGENTS.md"

# Subagent role definitions
for f in "$HARNESS"/agents/*.md; do
  link "$f" "$AGENT_DIR/agents/$(basename "$f")"
done

# Prompt templates
for f in "$HARNESS"/prompts/*.md; do
  link "$f" "$AGENT_DIR/prompts/$(basename "$f")"
done

# Extensions
link "$HARNESS/extensions/omarchy-system-theme.ts" "$AGENT_DIR/extensions/omarchy-system-theme.ts"
link "$HARNESS/extensions/verify-gate.ts" "$AGENT_DIR/extensions/verify-gate.ts"
link "$HARNESS/extensions/taste.ts" "$AGENT_DIR/extensions/taste.ts"
link "$HARNESS/extensions/repo-map.ts" "$AGENT_DIR/extensions/repo-map.ts"
link "$HARNESS/extensions/loop-guard.ts" "$AGENT_DIR/extensions/loop-guard.ts"
link "$HARNESS/extensions/autonomy.ts" "$AGENT_DIR/extensions/autonomy.ts"
link "$HARNESS/extensions/unreal.ts" "$AGENT_DIR/extensions/unreal.ts"
link "$HARNESS/extensions/subagent" "$AGENT_DIR/extensions/subagent"
link "$REPO/apps/pi-council/index.ts" "$AGENT_DIR/extensions/pi-council.ts"

# Omarchy skill, if this machine has omarchy
OMARCHY_SKILL="$HOME/.local/share/omarchy/default/omarchy-skill"
if [[ -d "$OMARCHY_SKILL" ]]; then
  link "$OMARCHY_SKILL" "$AGENT_DIR/skills/omarchy"
fi

# Merge harness packages into settings.json (preserves existing settings)
SETTINGS="$AGENT_DIR/settings.json"
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
RUNTIME="$(command -v bun || command -v node)" || {
  echo "warning: neither bun nor node found; skipped package merge" >&2
  exit 0
}
"$RUNTIME" -e '
  const fs = require("fs");
  const [settingsPath, packagesPath] = process.argv.slice(1);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const { packages } = JSON.parse(fs.readFileSync(packagesPath, "utf8"));
  const merged = [...new Set([...(settings.packages ?? []), ...packages])];
  const added = merged.length - (settings.packages?.length ?? 0);
  settings.packages = merged;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  settings.json: ${added} package(s) added, ${merged.length} total`);
' "$SETTINGS" "$HARNESS/packages.json"

echo
echo "Done. Next steps on a fresh machine:"
echo "  bun install                # repo dependencies"
echo "  bun run engine install     # systemd units, shims, pi providers (models.json)"
echo "  bun run engine use council # or: llama | vllm | ds4"
