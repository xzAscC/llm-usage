# llm-usage

**Track ChatGPT / GLM / Grok subscription usage from your Hyprland bar.**

A small, local-first toolkit for people who use [OpenCode](https://opencode.ai) with **monthly coding subscriptions** (not pay-as-you-go Zen). It reads the same credentials OpenCode already stores, refreshes OAuth when needed, and shows remaining quotas where you actually look — the status bar.

| Surface | What you get |
|---------|----------------|
| **CLI** | Human table, JSON, Waybar module, desktop notify |
| **Quickshell bar** | Compact ring + click popup for OpenAI · GLM · Grok |

No Electron, no cloud account, no global npm install. Just Bun + your existing OpenCode logins.

---

## Features

- **OpenAI (ChatGPT Plus/Pro OAuth)**  
  Weekly rate windows, credit balance, **rate-limit reset credits** (count + next expiry)
- **GLM / Z.AI Coding Plan**  
  Session (5h) + weekly **token** quotas (tool/search usage ignored)
- **Grok / xAI**  
  **Weekly SuperGrok** pool (same meter as the grok.com usage UI)
- **Claude Code**  
  Session 5h + weekly windows from `api/oauth/usage` (reads `~/.claude/.credentials.json`)
- **Auto OAuth refresh** for OpenAI and Claude Code; xAI refresh stays owned by OpenCode to avoid rotating-token races
- **Local cache only**: `~/.cache/llm-usage/snapshot.json` (percentages — never tokens)
- **Tests**: `bun test`

---

## Requirements

- [Bun](https://bun.sh) on `PATH` (runtime only)
- [OpenCode](https://opencode.ai) with providers connected:
  - OpenAI → ChatGPT Plus/Pro OAuth
  - `zai-coding-plan` → API key
  - xAI → OAuth
  - Claude Code → `claude auth login` (or OpenCode Anthropic OAuth)
- Optional UI: [Hyprland](https://hyprland.org) + [Quickshell](https://quickshell.outfoxxed.me) (e.g. dots-hyprland `ii`)

---

## Quick start (CLI)

```bash
git clone https://github.com/xzAscC/llm-usage.git
cd llm-usage

./bin/llm-usage status      # table in the terminal
./bin/llm-usage json        # structured snapshot
./bin/llm-usage waybar      # Waybar custom module JSON
./bin/llm-usage notify      # notify-send if usage is high
./bin/llm-usage status --force
```

```bash
bun test
```

---

## Quickshell bar (Hyprland)

Widget source (self-contained):

```text
integrations/quickshell/bar/LlmUsageBar.qml
```

Add a `Loader` next to your bar resources (example for dots-hyprland `BarContent.qml`):

```qml
Loader {
    id: llmUsageLoader
    active: root.useShortenedForm < 2
    Layout.alignment: Qt.AlignVCenter
    Layout.preferredWidth: item ? item.implicitWidth : 0
    Layout.preferredHeight: item ? item.implicitHeight : 0
    // set to YOUR clone path
    source: "file:///home/YOU/path/to/llm-usage/integrations/quickshell/bar/LlmUsageBar.qml"
}
```

Also set `projectRoot` (and `bunPath` if needed) near the top of `LlmUsageBar.qml` to match your machine.

| Input | Action |
|-------|--------|
| Left click | Open 3-column details (closes when pointer leaves) |
| Right click | Force refresh |

Reload the shell, e.g. `killall qs; qs -c ii &`.

---

## How it works

```
OpenCode auth.json  ──►  providers (OpenAI / Z.AI / xAI APIs)
                              │
                              ▼
                     ~/.cache/llm-usage/snapshot.json
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
           CLI status     Waybar JSON    Quickshell bar
```

OpenAI and Claude Code access tokens are refreshed through their official endpoints when expired. For xAI, OpenCode remains the sole refresh owner; this tool reloads the rotated access token from OpenCode's auth file instead of consuming the shared refresh token.

---

## Privacy & local-only policy

- Credentials never leave your machine except to the provider usage APIs you already use
- Snapshot cache stores usage percentages / reset times only — **no tokens**
- No telemetry, no cloud backend, no global package install

---

## License

MIT

---

## Config (optional)

`~/.config/llm-usage/config.json`:

```json
{
  "openai": {
    "resetCreditsDisplay": "all"
  }
}
```

| Value | Meaning |
|-------|---------|
| `"all"` (default) | List every rate-limit reset credit expiry |
| `"summary"` | Compact: `4 available · next exp 7/18` |
