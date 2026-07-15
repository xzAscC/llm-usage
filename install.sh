#!/usr/bin/env bash
# Local-only. Does NOT install global packages.
# Applies the minimal Quickshell BarContent Loader line if missing.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BAR="${XDG_CONFIG_HOME:-$HOME/.config}/quickshell/ii/modules/ii/bar/BarContent.qml"
SRC="file://$ROOT/integrations/quickshell/bar/LlmUsageBar.qml"

if [[ ! -f "$BAR" ]]; then
  echo "BarContent.qml not found at $BAR — skip QS patch."
  echo "CLI still works: $ROOT/bin/llm-usage status"
  exit 0
fi

if grep -q 'llmUsageLoader\|LLMUsage/integrations/quickshell/bar/LlmUsageBar.qml' "$BAR"; then
  echo "ok  BarContent already loads LlmUsageBar"
else
  echo "Manual step: add Loader in BarContent leftCenterGroup:"
  cat <<SNIP

            Loader {
                id: llmUsageLoader
                active: root.useShortenedForm < 2
                Layout.alignment: Qt.AlignVCenter
                Layout.preferredWidth: item ? item.implicitWidth : 0
                Layout.preferredHeight: item ? item.implicitHeight : 0
                source: "$SRC"
            }

SNIP
fi

echo "CLI: $ROOT/bin/llm-usage status"
echo "Reload QS: killall qs; qs -c ii &"
