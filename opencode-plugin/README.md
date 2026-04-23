# opencode-raycast-state

OpenCode plugin that maintains a live state file of all sessions for the
[`raycast-opencode`](https://github.com/va3093/raycast-opencode) Raycast
extension. It also correlates each session with a Ghostty terminal window and
uses Anthropic Haiku to auto-rename sessions and summarise their state.

## What it does

- Writes `~/.local/state/opencode-raycast/sessions.json` — one entry per
  session — as opencode events fire.
- Listens to `session.created`, `session.updated`, `session.deleted`,
  `message.updated`, and `session.idle`.
- Tracks a three-state status per session:
  - `in_progress` — assistant is working, or new activity.
  - `waiting_for_input` — last message was from the user and the session is
    idle.
  - `finished` — last message was from the assistant and the session is idle.
- Looks up the matching Ghostty window/terminal via AppleScript by matching
  Ghostty's `OC | <title>` window names against the session title and
  directory, and stores the terminal UUID for Raycast to use when focusing.
- On user messages, debounces a call to Haiku to produce a short `title` +
  `description` and patches the opencode session title back via the SDK.
- On `session.idle`, asks Haiku for a 2–3 sentence summary of the session's
  current state and stores it as `description`.

## Requirements

- macOS with Ghostty 1.3+ (for AppleScript support).
- `ANTHROPIC_API_KEY` in the opencode server's environment for auto-rename
  and summary (plugin runs as a no-op for those features if unset).

## Install

### Option 1 — as a local plugin (recommended for development)

```sh
cd opencode-plugin
bun install
bun run build

# Symlink the built plugin into your opencode global plugins directory
mkdir -p ~/.config/opencode/plugins
ln -sf "$(pwd)/dist/index.js" ~/.config/opencode/plugins/opencode-raycast-state.js
```

Opencode picks up files in `~/.config/opencode/plugins/` at startup. Restart
any running `opencode serve` / TUI sessions.

Optional env var overrides:

- `OPENCODE_RAYCAST_HAIKU_MODEL` — Anthropic model id to use for renames and
  summaries (default: `claude-haiku-4-5`).

### Option 2 — published npm package

Once published, add it to your opencode config:

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-raycast-state"]
}
```

## State file shape

```jsonc
{
  "version": 1,
  "updatedAt": 1714000000000,
  "sessions": {
    "<sessionID>": {
      "id": "<sessionID>",
      "directory": "/Users/you/code/project",
      "originalTitle": "Untitled Session",
      "title": "Fix login race condition",
      "description": "Reproducing the race with a failing test before fixing the token refresh.",
      "status": "in_progress",
      "lastRole": "user",
      "ghostty": {
        "terminalId": "7836343B-3355-495D-BC38-0D887A0CF587",
        "windowId": "tab-group-747258500",
        "correlatedAt": 1714000000000
      },
      "times": {
        "created": 1713999999000,
        "lastMessage": 1714000000000,
        "lastStatusChange": 1714000000000
      }
    }
  }
}
```

## Development

```sh
bun install
bun run typecheck
bun run build
```
