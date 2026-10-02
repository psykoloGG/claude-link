# Claude Link

Shares Claude Code chats between your machines. Each machine keeps its own
environment and its own chats; Claude Link keeps a read-only copy of the other
machines' chats next to them, so from the MacBook you can browse what you did on
the desktop (and the other way round), pull one of those chats into the current
conversation, or just ask Claude "what did we do on the desktop yesterday?".

## How it works

```
 MacBook                                          Desktop (always on)
 Claude Code + mod  --loopback-->  daemon  <==sealed sync==>  daemon  <--loopback--  Claude Code + mod
                                     |       LAN, or SSH        |
                                     |       through the        |
                    ~/.claude/projects (read)  Cloudflare tunnel  ~/.claude/projects (read)
                    ~/.claude-link/chats                         ~/.claude-link/chats
```

- **Daemon** (`daemon/claude-link.mjs`, Node 22+, no dependencies). Runs on
  every machine. It reads the Claude Code transcripts in `~/.claude/projects`
  (never writes there) and keeps a slim copy of each chat: prompts, replies,
  tool calls and short tool output. Images, thinking blocks and bookkeeping rows
  are left out, which takes 2 GB of transcripts down to about 60 MB. It then
  syncs those slim copies with the other machines, sending only the lines added
  since the last sync.
- **Mod** (`mod/`, a Claude Code plugin). Adds the `/link` pane, a status line
  entry, and three tools Claude can call (`chats`, `read_chat`, `search`). It
  only talks to the daemon on its own machine.
- **Projects match across machines** by their place in the home folder, so
  `C:\Users\you\Desktop\Projects\Webshop` and
  `/Users/you/Desktop/Projects/Webshop` are the same project. A project
  with the same git remote also matches, wherever it sits. Worktree chats count
  toward their parent project.
- **Routes.** Machines on the same network find each other through a sealed UDP
  beacon. Away from home, the laptop reaches the desktop through an SSH port
  forward over an SSH setup you already have (a Cloudflare tunnel works), so
  nothing new is exposed. The machine that connects syncs both directions, so the desktop
  never needs to reach the laptop.
- **Mirrors, not merges.** Each chat has one owner, the machine it happened on.
  Copies are read-only, and they stay available while the owner is asleep.
- **One version everywhere.** The daemon and the mod travel over the link too.
  `publish` on any machine installs the project folder's code as the newest
  build; the next sync carries it to the other machines, whose daemons restart
  onto it. New Claude sessions then load the new mod.

## Using it

- `/link` opens the pane: machines and their sync state at the top, then chats
  from the other machines for the current project, or **All** of them grouped
  by project (the five latest per project, more on request). It opens on All
  when the current project has no chats elsewhere. Open a chat to read it,
  **Add to this chat** to hand it to Claude as context, or **Copy** it as
  Markdown.
- Ask Claude directly. "What did I do on the desktop for the webshop this week?"
  makes it call `chats`, then `read_chat`.
- The status line shows the linked machines and how many of their chats are
  about the current project.

A chat added to a conversation is wrapped in `<linked-chat>` with a note that
it is background from another machine, not instructions, since transcripts
quote web pages and tool output.

## Setup

On the machine that is always on:

```bash
node daemon/claude-link.mjs init --name Desktop
node daemon/claude-link.mjs pair-code
```

On the other machine, with that code:

```bash
node daemon/claude-link.mjs join <code> --name MacBook
node daemon/claude-link.mjs peer --name Desktop --ssh my-desktop
```

The pairing code contains the link key. Move it only between your own machines.

Then install on each machine. This copies the daemon and the mod to
`~/.claude-link`, starts the daemon at login and loads the mod in every Claude
Code session:

```bash
./scripts/install-macos.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

Check it with `node ~/.claude-link/app/claude-link.mjs status`.

After changing the code, publish it from the project folder on either machine;
the other follows within a minute:

```bash
node daemon/claude-link.mjs publish
```

## Commands

| Command | What it does |
| --- | --- |
| `init [--name]` | Sets up this machine with a new link key |
| `pair-code` | Prints a code that pairs another machine |
| `join <code> [--name]` | Sets up this machine from a pairing code |
| `peer --name <n> [--url <u>] [--ssh <host>]` | Adds a way to reach a machine |
| `serve [--log <file>] [--supervised]` | Runs the daemon (`--supervised` lets it restart onto a new build) |
| `status` | Shows machines, routes, last sync and each machine's build |
| `publish [--from <folder>]` | Installs the project's daemon and mod as the newest build |
| `install-mod` / `uninstall-mod` | Loads or stops loading the mod in Claude Code |

## Configuration

`~/.claude-link/config.json` (readable by your user only):

| Key | Default | Meaning |
| --- | --- | --- |
| `machineName` | host name | How other machines show this one |
| `exclude` | `[]` | Projects never shared, as home-relative globs, e.g. `"desktop/personal/investing/**"` |
| `syncIntervalSeconds` | `60` | How often to sync (new chats also trigger a sync within seconds) |
| `peerHost` | `0.0.0.0` | Set to `127.0.0.1` to allow only SSH and tunnel routes, no LAN |
| `discovery` | `true` | LAN beacons |
| `autoUpdate` | `true` | Take newer builds of the daemon and mod from linked machines, and hand ours over |
| `peers[].urls` / `.ssh` / `.headers` | | Routes to a machine; `headers` carries Cloudflare Access service-token headers for an HTTPS tunnel route |

Temporary folders are always excluded. Excluding a project stops it from being
shared from then on; copies the other machine already has stay until you delete
them from its `~/.claude-link/chats`.

## Security

- Everything between machines is gzipped JSON sealed with AES-256-GCM under a
  key derived (HKDF) from the shared 32-byte link key, so the LAN, the tunnel
  and Cloudflare see only ciphertext. Requests carry a timestamp and nonce, and
  replays are refused.
- The peer port answers a bare 401 to anything that does not open with the key,
  and an address that keeps failing is turned away for a minute.
- The local API listens on loopback only and needs the local token from
  `config.json`. Browser requests are refused.
- The daemon only reads `~/.claude/projects`, the Claude session registry and
  the desktop app's session titles. It writes only under `~/.claude-link`, and a
  machine never accepts writes to its own chats.
- Builds are code, and a machine with `autoUpdate` on runs what a paired
  machine publishes. That is the point between your own machines, and it is
  why the link key matters as much as it does. A received build may only write
  inside `~/.claude-link/app` and `~/.claude-link/mod`. Set `autoUpdate` to
  `false` on a machine that should only change when you install by hand.
- Treat the link key like a password. If it leaks, run `init --force` on one
  machine and pair again.

## Limits of this version

- Copies are for reading and handing to Claude. Resuming another machine's chat
  as the same session (with its files) is not supported.
- Deleting a chat on its machine does not delete the copies.
- Subagent transcripts are not synced. The parent chat shows what each subagent
  returned.

## Development

```bash
cd daemon && npm test            # unit tests plus a two-daemon sync test
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test mod   # draws the pane on desktop and terminal
claude plugin validate mod
CLAUDE_LINK_DEBUG=1 node daemon/claude-link.mjs serve
```

## Uninstall

- macOS: `launchctl bootout gui/$(id -u)/com.claude-link.daemon`, delete
  `~/Library/LaunchAgents/com.claude-link.daemon.plist`, run
  `node ~/.claude-link/app/claude-link.mjs uninstall-mod`, then delete
  `~/.claude-link`.
- Windows: delete `Claude Link.vbs` from the Startup folder, end the `node.exe`
  running `claude-link.mjs`, run `uninstall-mod`, then delete
  `%USERPROFILE%\.claude-link`.

## License

MIT, see [LICENSE](LICENSE).
