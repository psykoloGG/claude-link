#!/bin/bash
# Installs Claude Link on this Mac:
#   1. publishes the daemon and the mod to ~/.claude-link (app/ and mod/); later
#      builds published on any linked machine arrive by themselves
#   2. runs the daemon as a LaunchAgent, so it starts at login and comes back if it stops
#   3. loads the mod in every Claude Code session (CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json)
# Set the link up first with "claude-link init" or "claude-link join".
#
# With --scope <scope> it installs the instance of an enrolled Claude profile
# instead ("claude-link profile enroll"): its own folder under
# ~/.claude-link-profiles/<scope>, its own LaunchAgent
# (com.claude-link.daemon.<scope>) and its mod in that profile's settings only.
# The default instance and other profiles are left alone.
#
# CLAUDE_LINK_LAUNCH_DIR (default ~/Library/LaunchAgents) and
# CLAUDE_LINK_LAUNCH_DOMAIN (default gui/<uid>) exist for disposable test runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCOPE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --scope) SCOPE="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -n "$SCOPE" ]; then
  if ! [[ "$SCOPE" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || [ "$SCOPE" = "default" ]; then
    echo "A scope is 1-32 lowercase letters, digits or dashes." >&2
    exit 1
  fi
  LINK_HOME="${CLAUDE_LINK_PROFILES_HOME:-$HOME/.claude-link-profiles}/$SCOPE"
  LABEL="com.claude-link.daemon.$SCOPE"
else
  LINK_HOME="${CLAUDE_LINK_HOME:-$HOME/.claude-link}"
  LABEL="com.claude-link.daemon"
fi
LAUNCH_DIR="${CLAUDE_LINK_LAUNCH_DIR:-$HOME/Library/LaunchAgents}"
DOMAIN="${CLAUDE_LINK_LAUNCH_DOMAIN:-gui/$(id -u)}"
PLIST="$LAUNCH_DIR/$LABEL.plist"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "Node.js is required (brew install node)." >&2
  exit 1
fi
if [ ! -f "$LINK_HOME/config.json" ]; then
  if [ -n "$SCOPE" ]; then
    echo "Enroll the profile first: node \"$ROOT/daemon/claude-link.mjs\" profile enroll --scope $SCOPE ..." >&2
  else
    echo "Set up the link first: node \"$ROOT/daemon/claude-link.mjs\" init --name <name> (or join <code>)." >&2
  fi
  exit 1
fi

# Only the named instance gets CLAUDE_LINK_HOME; the default stays as before.
EXTRA_ENV=""
if [ -n "$SCOPE" ]; then
  EXTRA_ENV="    <key>CLAUDE_LINK_HOME</key>
    <string>$LINK_HOME</string>
    <key>CLAUDE_LINK_PROFILES_HOME</key>
    <string>$(dirname "$LINK_HOME")</string>"
fi

mkdir -p "$LAUNCH_DIR"
CLAUDE_LINK_HOME="$LINK_HOME" "$NODE" "$ROOT/daemon/claude-link.mjs" publish --from "$ROOT"

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
$EXTRA_ENV
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

# Replace a daemon started by hand or by an earlier install of this same
# instance. A profile install only stops its own copy; the default install
# leaves profile instances running.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
PROFILES_DIR="${CLAUDE_LINK_PROFILES_HOME:-$HOME/.claude-link-profiles}"
for pid in $(pgrep -f "claude-link.mjs serve" 2>/dev/null || true); do
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  if [ -n "$SCOPE" ]; then
    case "$cmd" in *"$LINK_HOME/app/claude-link.mjs serve"*) kill "$pid" 2>/dev/null || true ;; esac
  else
    case "$cmd" in *"$PROFILES_DIR/"*) ;; *) kill "$pid" 2>/dev/null || true ;; esac
  fi
done
sleep 1
launchctl bootstrap "$DOMAIN" "$PLIST"

CLAUDE_LINK_HOME="$LINK_HOME" "$NODE" "$LINK_HOME/app/claude-link.mjs" install-mod "$LINK_HOME/mod"
echo "Claude Link is running. Check it with: node \"$LINK_HOME/app/claude-link.mjs\" status${SCOPE:+ --scope $SCOPE}"
