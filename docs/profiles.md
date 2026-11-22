# Claude Link with several Claude profiles

Opt-in. If you only use one Claude Code setup (`~/.claude`), nothing here
applies and nothing changes: the default instance keeps its folder
(`~/.claude-link`), ports, link key, LaunchAgent and `/link` behaviour.

Some setups run more than one Claude profile on a machine, each with its own
Claude Code folder passed in `CLAUDE_CONFIG_DIR` (for example profiles made with
[claude-multiprofile](https://github.com/jmdarre-v/claude-multiprofile), which
exports `CLAUDE_CONFIG_DIR` both to the CLI and to its combined Desktop and
Code launchers). Claude Link can serve each of those profiles separately, so
`/link` and its tools in a work session only ever show work chats from your
other machines, and personal sessions only personal ones.

## The model

Every enrolled profile gets its **own Claude Link instance**:

| | Default | Enrolled profile `<scope>` |
| --- | --- | --- |
| Folder | `~/.claude-link` | `~/.claude-link-profiles/<scope>` |
| Reads chats from | `~/.claude/projects` | that profile's Claude Code folder only |
| Desktop titles from | the default Desktop app | that profile's Desktop data folder, or none (Code only) |
| Link key, machine id, local token | own | own |
| Ports (local, peer, LAN discovery) | 47600-47602 | own range, 47610+ by default |
| macOS LaunchAgent | `com.claude-link.daemon` | `com.claude-link.daemon.<scope>` |
| Mod loaded from | `~/.claude/settings.json` | that profile's `settings.json`, with `CLAUDE_LINK_HOME` |
| Builds (`autoUpdate`) | as configured | off by default, never shared between profiles |

The **sync scope** (`work`, `personal`, ...) is the name both machines agree on
for a profile. You pick it when you enroll, and it must be the same on both
Macs. It is not taken from the profile's display name or its folder, so the
profile can live at different paths on each machine, or be renamed in the
profile manager, and still pair with the right counterpart.

What syncs is exactly what the default instance syncs: slim, read-only copies
of Claude Code transcripts. Ordinary Desktop or Cowork chats, credentials,
keychains, connectors, settings, project files and resumable session state are
not synced.

### How profiles are kept apart

- **Pairing.** A profile's pairing code (`clinkp1.` prefix) names its scope.
  `join` refuses a code for a different profile, including default versus named
  in either direction, and changes nothing. Versions before this change refuse
  scoped codes outright.
- **On the wire.** A named instance mixes its scope into the key derivation,
  so its messages and LAN beacons do not open in any other profile's instance,
  even one that somehow holds the same link key. Its hello also names the
  scope. The default instance keeps the original derivation, so it still syncs
  with machines on the previous version.
- **Locally.** The mod sends the session's `CLAUDE_CONFIG_DIR` with every
  request. The instance answers only when that resolves (symlinks and aliases
  included) to the Claude Code folder it was enrolled with; anything else gets
  an error, never another profile's data. A named instance also refuses mods
  that predate this change. A session of a profile with no instance of its own
  (no `CLAUDE_LINK_HOME` in its settings) is told to enroll it; the mod does not
  fall back to the default instance or look for other profiles.
- **Placement.** A profile's `config.json` only works in its own folder; a
  copied or moved config refuses to start. A profile whose Claude Code (or
  Desktop) folder was removed, renamed or swapped for a symlink elsewhere
  refuses to serve until it is enrolled again.

This keeps profiles from being mixed up by accident. It is **not** an OS
security boundary: programs running as your user can read every profile's
files anyway.

## Setup

Do this on both Macs, with the same scope on each. The default instance does
not need to exist, but if it does, it keeps working as before.

1. **Enroll the profile.** Either from the claude-multiprofile registry
   (looked up only for the profile you name; never written, never scanned):

   ```bash
   node daemon/claude-link.mjs profile enroll --scope work --profile "<profile name>" --name MacBook
   ```

   or with explicit folders, for profiles from a hand-made launcher. Both
   folders must already exist:

   ```bash
   node daemon/claude-link.mjs profile enroll --scope work \
     --code-dir "/path/to/that profile's CLAUDE_CONFIG_DIR" \
     --desktop-dir "/path/to/that profile's Desktop --user-data-dir" \
     --name MacBook
   ```

   Leave out `--desktop-dir` for a Code-only profile (titles then come from the
   transcripts). Enrollment refuses: a Desktop-only profile (it has no Claude
   Code folder of its own, so its chats are the default profile's), the default
   `~/.claude` or anything overlapping it (including symlinks to it), a folder
   another profile already has, the default Desktop data folder, and ports in
   use. Pick ports with `--port-base <n>` (uses n, n+1, n+2) if needed.

2. **Pair.** On the always-on machine, then on the other:

   ```bash
   node daemon/claude-link.mjs pair-code --scope work
   node daemon/claude-link.mjs join <code> --scope work
   node daemon/claude-link.mjs peer --scope work --name Desktop --ssh my-desktop   # optional
   ```

3. **Install** (macOS). Runs the instance at login under its own label and
   loads its mod in that profile only:

   ```bash
   ./scripts/install-macos.sh --scope work
   ```

   This writes `CLAUDE_CODE_PLUGIN_DIRS`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`
   and `CLAUDE_LINK_HOME` into the env block of the profile's own
   `settings.json` (a backup goes next to it), stops only that instance's
   previous daemon, and leaves the default instance and other profiles alone.
   Your launcher is not changed. Sessions must be started with that profile's
   `CLAUDE_CONFIG_DIR` (claude-multiprofile's launchers do this) to pick up the
   mod.

Repeat for each profile with its own scope.

## Status

```bash
node daemon/claude-link.mjs profile status --scope work   # binding, ports, label; exit 1 on problems
node daemon/claude-link.mjs status --scope work           # the running instance and its machines
```

`profile status` also re-reads the registry entry it was enrolled from (if
any) and reports when that entry was removed or now points elsewhere. Claude
Link never follows such a change by itself: run `profile enroll --scope work
--force ...` to re-bind after you move a profile; its link key, machine id,
pairings and ports are kept.

Every other command accepts `--scope` the same way (`publish`, `peer`,
`install-mod`, `uninstall-mod`, `serve`). Without `--scope`, commands act on
the default instance, as before.

## Rollback

Per profile, on each Mac (nothing here touches the default instance):

```bash
launchctl bootout gui/$(id -u)/com.claude-link.daemon.work
rm ~/Library/LaunchAgents/com.claude-link.daemon.work.plist
node ~/.claude-link-profiles/work/app/claude-link.mjs uninstall-mod --scope work
rm -rf ~/.claude-link-profiles/work
```

`uninstall-mod --scope` removes the mod folder and `CLAUDE_LINK_HOME` from that
profile's `settings.json`; the file as it was before the last install is in
`settings.json.before-claude-link`. Removing every profile means doing this for
each and then deleting `~/.claude-link-profiles`.

To go back to a version without profile support, roll back each profile as
above first. The default instance needs nothing: its config, data, ports and
wire format are unchanged by this version.

## Limits

- **Desktop live paths are not verified here.** The tests use synthetic
  folders laid out like the Desktop app's (`<data dir>/claude-code-sessions`),
  and rely on the Desktop app passing the profile's `CLAUDE_CONFIG_DIR` to the
  Claude Code sessions it starts and those sessions applying that profile's
  `settings.json` env block. Check `/link` in a Desktop Code session of each
  profile after installing.
- Windows: `scripts/install-windows.ps1` has no `--scope` yet; the daemon
  commands work there, but you would have to start a named instance yourself.
- An existing default setup that already runs with a custom
  `CLAUDE_CONFIG_DIR` is unaffected, but `install-mod` for the default instance
  now refuses when `CLAUDE_CONFIG_DIR` points at a different folder than the
  default instance reads, instead of writing the default mod into another
  profile's settings.
- A named profile and the default instance on the same Mac are independent
  peers; there is no view across profiles, by design.
