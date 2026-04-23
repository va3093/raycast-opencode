# LaunchAgent: always-on `ray develop`

Raycast extensions installed from source must have a running `ray develop`
process for Raycast to pick them up. This LaunchAgent keeps it running at
login so the extension is always available without having to remember to
`bun run dev`.

## Install

```sh
mkdir -p ~/Library/Logs/raycast-opencode
cp launchagents/com.va3093.raycast-opencode.plist ~/Library/LaunchAgents/

uid=$(id -u)
launchctl bootout  gui/$uid/com.va3093.raycast-opencode 2>/dev/null || true
launchctl bootstrap gui/$uid ~/Library/LaunchAgents/com.va3093.raycast-opencode.plist
launchctl kickstart -k gui/$uid/com.va3093.raycast-opencode
```

## Status & logs

```sh
uid=$(id -u)
launchctl print gui/$uid/com.va3093.raycast-opencode | grep -E "state|pid|last exit"
tail -f ~/Library/Logs/raycast-opencode/develop.log
tail -f ~/Library/Logs/raycast-opencode/develop.error.log
```

## Customise

The plist hardcodes a Node binary at `~/.nvm/versions/node/v24.14.0/bin/node`
and the working directory at `~/code/personal/raycast-opencode`. Edit both
before installing if your setup differs.

## Uninstall

```sh
uid=$(id -u)
launchctl bootout gui/$uid/com.va3093.raycast-opencode
rm ~/Library/LaunchAgents/com.va3093.raycast-opencode.plist
```
