#!/bin/bash
# Installs Claude Link on this Mac:
#   1. publishes the daemon and the mod to ~/.claude-link (app/ and mod/); later
#      builds published on any linked machine arrive by themselves
#   2. runs the daemon as a LaunchAgent, so it starts at login and comes back if it stops
#   3. loads the mod in every Claude Code session (CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json)
# Set the link up first with "claude-link init" or "claude-link join".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LINK_HOME="${CLAUDE_LINK_HOME:-$HOME/.claude-link}"
LABEL="com.claude-link.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "Node.js is required (brew install node)." >&2
  exit 1
fi
if [ ! -f "$LINK_HOME/config.json" ]; then
  echo "Set up the link first: node \"$ROOT/daemon/claude-link.mjs\" init --name <name> (or join <code>)." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
"$NODE" "$ROOT/daemon/claude-link.mjs" publish --from "$ROOT"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$LINK_HOME/app/claude-link.mjs</string>
    <string>serve</string>
    <string>--log</string>
    <string>$LINK_HOME/daemon.log</string>
    <string>--supervised</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardErrorPath</key>
  <string>$LINK_HOME/daemon.err.log</string>
</dict>
</plist>
EOF

# Replace a daemon started by hand or by an earlier install.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "claude-link.mjs serve" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"

"$NODE" "$LINK_HOME/app/claude-link.mjs" install-mod "$LINK_HOME/mod"
echo "Claude Link is running. Check it with: node \"$LINK_HOME/app/claude-link.mjs\" status"
