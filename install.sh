#!/usr/bin/env bash
# Local-only Quickshell integration. No global package installs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QS_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/quickshell/ii"

link_file() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [[ -L "$dest" ]]; then
    local cur
    cur="$(readlink -f "$dest" || true)"
    local want
    want="$(readlink -f "$src")"
    if [[ "$cur" == "$want" ]]; then
      echo "ok  $dest"
      return 0
    fi
    rm -f "$dest"
  elif [[ -e "$dest" ]]; then
    mv "$dest" "${dest}.bak.$(date +%Y%m%d%H%M%S)"
    echo "bak $dest"
  fi
  ln -s "$src" "$dest"
  echo "ln  $dest -> $src"
}

echo "Installing llm-usage Quickshell links (local only)…"
link_file "$ROOT/integrations/quickshell/services/LlmUsage.qml" \
  "$QS_ROOT/services/LlmUsage.qml"
link_file "$ROOT/integrations/quickshell/bar/LlmUsageBar.qml" \
  "$QS_ROOT/modules/ii/bar/LlmUsageBar.qml"
link_file "$ROOT/integrations/quickshell/bar/LlmUsagePopup.qml" \
  "$QS_ROOT/modules/ii/bar/LlmUsagePopup.qml"

echo
echo "Ensure BarContent.qml includes LlmUsageBar and Config has bar.llmUsage."
echo "CLI (project-local): $ROOT/bin/llm-usage status"
echo "Done."
