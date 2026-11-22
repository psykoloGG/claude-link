#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startLocalApi } from './lib/api.mjs'
import { bundleHash, formatBuild, installBundle, readBundleInfo, sourceFiles } from './lib/bundle.mjs'
import { LINK_VERSION, checkPairScope, claudeHome, configExists, configPath, createConfig, instanceScope, linkHome, loadConfig, makePairCode, readPairCode, saveConfig } from './lib/config.mjs'
import { startDiscovery } from './lib/discovery.mjs'
import { debug, print, setLogFile } from './lib/log.mjs'
import { startPeerServer } from './lib/peer.mjs'
import { ProfileError, canonicalDir, defaultCodeRoot, launchLabel, profileHome, readRegistryProfile, resolveEnrollment, validateScope, verifyBinding } from './lib/profile.mjs'
import { deriveKey } from './lib/seal.mjs'
import { ChatStore } from './lib/store.mjs'
import { SyncEngine } from './lib/sync.mjs'

const OWN_SCAN_INTERVAL_MS = 60 * 1000
const BUILD_CHECK_INTERVAL_MS = 15 * 1000
const SCRIPT_PATH = fileURLToPath(import.meta.url)

// A background launcher restarts the daemon when it exits, except with
// DoNotRestart: another daemon already runs, or this machine is not set up.
const ExitCode = Object.freeze({
  Failure: 1,
  DoNotRestart: 3,
})

class StartupError extends Error {
  constructor(message) {
    super(message)
    this.exitCode = ExitCode.DoNotRestart
  }
}

const USAGE = `Claude Link ${LINK_VERSION}: share Claude Code chats between your machines.

Usage:
  claude-link init [--name <name>]          Set up this machine with a new link key
  claude-link pair-code                     Print a code that pairs another machine with this one
  claude-link join <code> [--name <name>]   Set up this machine with a code from another machine
  claude-link peer --name <name> [--url <url>] [--ssh <host>] [--ssh-port <port>]
                                            Add or update how to reach a linked machine
  claude-link serve [--log <file>] [--supervised]
                                            Run the link daemon
  claude-link status                        Show what the running daemon sees
  claude-link publish [--from <folder>]     Install this project's daemon and mod as the
                                            newest build; linked machines follow on sync
  claude-link install-mod [folder]          Load the mod in every Claude Code session
  claude-link uninstall-mod [folder]        Stop loading the mod

Profiles (opt in, one separate instance per Claude Code profile):
  claude-link profile enroll --scope <scope> (--profile <name> | --code-dir <folder> [--desktop-dir <folder>])
                            [--name <machine>] [--port-base <port>] [--force]
                                            Set up an instance for one profile
  claude-link profile status --scope <scope>
                                            Check what an enrolled profile is bound to
  Add --scope <scope> to any command above (pair-code, join, peer, serve,
  status, publish, install-mod, uninstall-mod) to run it for that profile.`

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next
        index += 1
      } else {
        flags[name] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function defaultName() {
  return os.hostname().replace(/\.local$/, '')
}

async function init(flags) {
  if (flags.scope) {
    throw new Error('A profile is set up with "claude-link profile enroll --scope <scope> ...", not init.')
  }
  if ((await configExists()) && !flags.force) {
    throw new Error(`${configPath()} already exists (use --force to replace it and its link key)`)
  }
  const config = createConfig({ name: typeof flags.name === 'string' ? flags.name : defaultName() })
  await saveConfig(config)
  print(`Set up "${config.machineName}". Next:`)
  print('  1. Run "claude-link pair-code" here and "claude-link join <code>" on your other machine.')
  print('  2. Start the daemon on both machines with "claude-link serve" (or the install script).')
}

async function pairCode() {
  const config = await loadConfig()
  print('Pairing code (it contains the link key: only move it between your own machines):')
  print()
  print(makePairCode(config))
}

async function join(positional, flags) {
  const payload = readPairCode(positional[1])
  let config = (await configExists()) ? await loadConfig() : null
  if (!config && flags.scope) {
    throw new Error('Enroll this profile here first ("claude-link profile enroll --scope ..."), then join.')
  }
  checkPairScope(config ?? {}, payload)
  // A freshly enrolled profile has its own key but nothing paired yet, so
  // taking the other machine's key loses nothing.
  const isUnpairedProfile = Boolean(config?.profile) && config.peers.length === 0
  if (config && config.linkKey !== payload.key && !flags.force && !isUnpairedProfile) {
    throw new Error('This machine already has a different link key (use --force to switch to the new one)')
  }
  if (!config) {
    config = createConfig({ name: typeof flags.name === 'string' ? flags.name : defaultName(), linkKey: payload.key })
  }
  config.linkKey = payload.key
  if (typeof flags.name === 'string') {
    config.machineName = flags.name
  }
  const existing = config.peers.find(peer => peer.machineId === payload.id || peer.name.toLowerCase() === payload.name.toLowerCase())
  const sshPort = payload.scope && Number.isInteger(payload.peerPort) ? { sshPort: payload.peerPort } : {}
  if (existing) {
    existing.machineId = payload.id
    existing.urls = payload.urls
    Object.assign(existing, sshPort)
  } else {
    config.peers.push({ name: payload.name, machineId: payload.id, urls: payload.urls, ...sshPort })
  }
  await saveConfig(config)
  print(`Joined "${payload.name}" as "${config.machineName}". Start the daemon with "claude-link serve".`)
}

async function peer(flags) {
  if (typeof flags.name !== 'string') {
    throw new Error('peer needs --name <name>')
  }
  const config = await loadConfig()
  let entry = config.peers.find(candidate => candidate.name.toLowerCase() === flags.name.toLowerCase())
  if (!entry) {
    entry = { name: flags.name, urls: [] }
    config.peers.push(entry)
  }
  if (typeof flags.url === 'string' && !entry.urls.includes(flags.url)) {
    entry.urls.push(flags.url)
  }
  if (typeof flags.ssh === 'string') {
    entry.ssh = flags.ssh
  }
  if (typeof flags['ssh-port'] === 'string') {
    entry.sshPort = Number(flags['ssh-port'])
  }
  await saveConfig(config)
  print(`Saved how to reach "${entry.name}".`)
}

async function status() {
  const config = await loadConfig()
  let response = null
  try {
    response = await fetch(`http://127.0.0.1:${config.localPort}/api/status`, {
      headers: { authorization: `Bearer ${config.localToken}`, 'x-claude-link-root': encodeURIComponent(config.profile ? config.profile.codeDir : claudeHome(config)) },
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    throw new Error('The link daemon is not running here (start it with "claude-link serve")')
  }
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error ?? `The link daemon answered HTTP ${response.status}`)
  }
  const scope = data.profile?.scope ?? ''
  if (scope !== instanceScope(config)) {
    throw new Error('The daemon on this port serves a different profile; check the ports in config.json.')
  }
  print(`${data.machine.name}${scope ? ` [profile ${scope}]` : ''}: ${data.counts.local} own chats, ${data.counts.remote} from other machines`)
  print(`  build ${formatBuild(data.build)}`)
  if (data.indexing.isRunning) {
    print(`Indexing ${data.indexing.done} of ${data.indexing.total} transcripts`)
  }
  for (const entry of data.peers) {
    const state = entry.isOnline ? `online over ${entry.route}` : `offline${entry.lastError ? ` (${entry.lastError})` : ''}`
    const synced = entry.lastSyncAt ? `, synced ${new Date(entry.lastSyncAt).toLocaleTimeString()}` : ''
    const build = entry.build?.hash ? (entry.build.hash === data.build.hash ? ', same build' : `, build ${formatBuild(entry.build)}`) : ''
    print(`  ${entry.name}: ${state}${synced}${build}`)
  }
  if (data.peers.length === 0) {
    print('  No linked machines yet.')
  }
}

// Installs the daemon and mod from the project folder (daemon/ and mod/ side
// by side) as this machine's build. Content decides the build's identity, so
// publishing unchanged code is a no-op.
async function publish(flags) {
  const projectRoot = path.resolve(typeof flags.from === 'string' ? flags.from : path.join(path.dirname(SCRIPT_PATH), '..'))
  const hasProject = await Promise.all([
    fs.access(path.join(projectRoot, 'daemon', 'claude-link.mjs')),
    fs.access(path.join(projectRoot, 'mod', '.claude-plugin', 'plugin.json')),
  ]).then(() => true, () => false)
  if (!hasProject) {
    throw new Error('Run publish from the Claude Link project folder (daemon/ and mod/ side by side), or pass --from <folder>')
  }
  const files = await sourceFiles(projectRoot)
  const current = await readBundleInfo()
  if (bundleHash(files) === current.hash) {
    print(`This build is already installed: ${formatBuild(current)}.`)
    return
  }
  const installed = await installBundle(files, Date.now())
  print(`Published build ${formatBuild(installed)}. Linked machines switch to it on their next sync.`)
}

// Claude Code loads plugin folders named in CLAUDE_CODE_PLUGIN_DIRS, which it
// also reads from the env block of ~/.claude/settings.json; that is how the
// desktop app's sessions get the mod. Mods are early access, so the switch
// that turns them on goes in the same block. The previous settings are kept
// as a backup next to the file.
//
// A named profile's mod goes into that profile's own settings.json, together
// with CLAUDE_LINK_HOME, which is how its sessions find their own instance.
async function settingsTarget() {
  const config = (await configExists()) ? await loadConfig() : null
  if (config?.profile) {
    return { file: path.join(config.profile.codeDir, 'settings.json'), linkHomeValue: linkHome() }
  }
  const root = config?.claudeDir || defaultCodeRoot()
  const fromEnv = process.env.CLAUDE_CONFIG_DIR
  if (fromEnv && (await canonicalDir(fromEnv)) !== (await canonicalDir(root))) {
    throw new Error('CLAUDE_CONFIG_DIR points at another Claude profile. Use --scope <scope> for an enrolled profile, or unset CLAUDE_CONFIG_DIR for the default one.')
  }
  return { file: path.join(root, 'settings.json'), linkHomeValue: '' }
}

async function setModLoaded(positional, isLoaded) {
  const modFolder = path.resolve(positional[1] ?? path.join(linkHome(), 'mod'))
  const { file: settingsFile, linkHomeValue } = await settingsTarget()
  const original = await fs.readFile(settingsFile, 'utf8').catch(() => '{}')
  const settings = JSON.parse(original)
  settings.env = settings.env ?? {}
  const folders = String(settings.env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(path.delimiter).filter(folder => folder && folder !== modFolder)
  if (isLoaded) {
    folders.push(modFolder)
  }
  if (folders.length > 0) {
    settings.env.CLAUDE_CODE_PLUGIN_DIRS = folders.join(path.delimiter)
    settings.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1'
  } else {
    delete settings.env.CLAUDE_CODE_PLUGIN_DIRS
    delete settings.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
  }
  if (linkHomeValue && isLoaded) {
    settings.env.CLAUDE_LINK_HOME = linkHomeValue
  } else if (linkHomeValue && settings.env.CLAUDE_LINK_HOME === linkHomeValue) {
    delete settings.env.CLAUDE_LINK_HOME
  }
  await fs.writeFile(`${settingsFile}.before-claude-link`, original)
  await fs.writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
  print(isLoaded ? `New Claude Code sessions load the mod from ${modFolder}.` : 'New Claude Code sessions no longer load the mod.')
}

// When a newer build lands in ~/.claude-link (published here or received from
// another machine), the installed daemon exits so its launcher starts the new
// code. A daemon run by hand, or from the project folder, only says so.
async function watchForNewBuild(flags, restart) {
  const isInstalledCopy = SCRIPT_PATH.startsWith(path.join(linkHome(), 'app') + path.sep)
  const runningBuild = await readBundleInfo()
  let hasWarned = false
  return setInterval(async () => {
    const current = await readBundleInfo()
    if (!current.hash || current.hash === runningBuild.hash) {
      return
    }
    if (isInstalledCopy && flags.supervised) {
      debug.warn(`Restarting onto build ${formatBuild(current)}`)
      restart()
    } else if (!hasWarned) {
      hasWarned = true
      debug.warn(`Build ${formatBuild(current)} is installed; restart the daemon to run it`)
    }
  }, BUILD_CHECK_INTERVAL_MS)
}

function listen(server, label, port) {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', error => {
      reject(error.code === 'EADDRINUSE' ? new StartupError(`${label} port ${port} is in use (is the daemon already running?)`) : error)
    })
  })
}

async function serve(flags) {
  if (typeof flags.log === 'string') {
    await setLogFile(flags.log)
  }
  const config = await loadConfig().catch(error => {
    throw new StartupError(error.message)
  })
  await verifyBinding(config).catch(error => {
    throw new StartupError(error.message)
  })
  const scope = instanceScope(config)
  const key = deriveKey(config.linkKey, scope)
  const boundRoot = await canonicalDir(claudeHome(config))
  const store = new ChatStore(config)
  await store.init()
  const sync = new SyncEngine({ config, key, store })
  const api = startLocalApi({ config, store, sync, boundRoot })
  const peerServer = startPeerServer({ config, key, handlers: sync.handlers() })
  await Promise.all([listen(api, 'Local API', config.localPort), listen(peerServer, 'Peer', config.peerPort)])
  const discovery = config.discovery ? startDiscovery({ config, key, onBeacon: beacon => sync.noteBeacon(beacon) }) : null

  const rescan = async () => {
    try {
      if ((await store.scanOwn()) > 0) {
        sync.trigger('local-change')
      }
    } catch (error) {
      debug.warn('Scanning transcripts failed:', error)
    }
  }
  store.watchOwn(rescan)
  const scanTimer = setInterval(rescan, OWN_SCAN_INTERVAL_MS)
  const buildTimer = await watchForNewBuild(flags, () => stop())
  debug.log(`Claude Link ${LINK_VERSION} serving "${config.machineName}"${scope ? ` for profile ${scope}` : ''} (local ${config.localPort}, peer ${config.peerHost}:${config.peerPort})`)

  let isStopping = false
  const stop = async () => {
    if (isStopping) {
      return
    }
    isStopping = true
    clearInterval(scanTimer)
    clearInterval(buildTimer)
    sync.stop()
    discovery?.close()
    api.close()
    peerServer.close()
    await store.close().catch(error => debug.warn('Could not save on exit:', error))
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await rescan()
  sync.start()
  await sync.syncAll('startup')
}

async function enroll(flags) {
  const scope = validateScope(flags.scope)
  if ((await configExists()) && !flags.force) {
    throw new Error(`The "${scope}" profile is already enrolled here (use --force to re-bind it after a move; its link key and pairings are kept).`)
  }
  const defaultConfig = await readDefaultConfig()
  const { profile, ports } = await resolveEnrollment({
    scope,
    profileName: typeof flags.profile === 'string' ? flags.profile : '',
    codeDir: typeof flags['code-dir'] === 'string' ? flags['code-dir'] : '',
    desktopDir: typeof flags['desktop-dir'] === 'string' ? flags['desktop-dir'] : '',
    defaultConfig,
    portBase: typeof flags['port-base'] === 'string' ? flags['port-base'] : undefined,
  })
  const previous = (await configExists()) ? await loadConfig().catch(() => null) : null
  const config = previous ?? createConfig({ name: typeof flags.name === 'string' ? flags.name : defaultName() })
  if (previous?.profile && previous.profile.scope !== scope) {
    throw new Error('That folder holds another profile\'s config; not touching it.')
  }
  // Re-binding after a move keeps the ports the other machine already knows.
  const keptPorts = previous && flags['port-base'] === undefined ? { localPort: previous.localPort, peerPort: previous.peerPort, discoveryPort: previous.discoveryPort } : ports
  Object.assign(config, keptPorts, {
    profile,
    claudeDir: profile.codeDir,
    // Builds never travel between profiles, and a named profile only changes
    // code when it is installed by hand unless the user turns this on.
    autoUpdate: previous ? previous.autoUpdate : false,
  })
  if (typeof flags.name === 'string') {
    config.machineName = flags.name
  }
  await saveConfig(config)
  print(`Enrolled profile "${scope}" (${profile.desktopDir ? 'Code and Desktop titles' : 'Code only'}) on ports ${config.localPort}-${config.discoveryPort}.`)
  print('Next, with --scope on both machines:')
  print(`  1. "claude-link pair-code --scope ${scope}" here, "claude-link join <code> --scope ${scope}" on the other machine (enrolled the same way).`)
  print(`  2. "./scripts/install-macos.sh --scope ${scope}" to run it at login and load its mod in that profile only.`)
}

async function readDefaultConfig() {
  const saved = process.env.CLAUDE_LINK_HOME
  delete process.env.CLAUDE_LINK_HOME
  try {
    return (await configExists()) ? JSON.parse(await fs.readFile(configPath(), 'utf8')) : null
  } catch {
    return null
  } finally {
    if (saved !== undefined) {
      process.env.CLAUDE_LINK_HOME = saved
    }
  }
}

async function profileStatus(flags) {
  const scope = validateScope(flags.scope)
  if (!(await configExists())) {
    throw new Error(`The "${scope}" profile is not enrolled here.`)
  }
  const config = await loadConfig()
  const problems = []
  await verifyBinding(config).catch(error => problems.push(error.message))
  if (config.profile.source === 'registry' && config.profile.registryName) {
    try {
      const entry = await readRegistryProfile(config.profile.registryName)
      if ((await canonicalDir(entry.codeDir)) !== config.profile.codeDir) {
        problems.push('The claude-multiprofile registry now points this profile at another Claude Code folder; re-enroll with --force if that is intended.')
      }
    } catch (error) {
      problems.push(`Registry check: ${error.message}`)
    }
  }
  print(`Profile "${scope}"`)
  print(`  Claude Code folder: ${tilde(config.profile.codeDir)}`)
  print(`  Desktop titles: ${config.profile.desktopSessionsDir ? tilde(config.profile.desktopSessionsDir) : 'none (Code only)'}`)
  print(`  Bound from: ${config.profile.source === 'registry' ? 'claude-multiprofile registry' : 'explicit paths'}`)
  print(`  Ports: local ${config.localPort}, peer ${config.peerPort}, discovery ${config.discoveryPort}`)
  print(`  Launch label: ${launchLabel(scope)}`)
  print(`  Linked machines: ${config.peers.length}`)
  print(problems.length ? `  Problems:\n${problems.map(problem => `    - ${problem}`).join('\n')}` : '  Binding OK')
  if (problems.length) {
    process.exitCode = 1
  }
}

function tilde(folder) {
  const home = os.homedir()
  return folder && folder.startsWith(home + path.sep) ? `~${folder.slice(home.length)}` : folder
}

// --scope picks a named profile's instance for any command. It is the only
// way a command reaches one: there is no lookup across profiles.
function selectInstance(flags) {
  if (flags.scope === undefined) {
    return
  }
  const home = profileHome(validateScope(flags.scope))
  if (process.env.CLAUDE_LINK_HOME && path.resolve(process.env.CLAUDE_LINK_HOME) !== path.resolve(home)) {
    throw new Error('CLAUDE_LINK_HOME and --scope name different instances.')
  }
  process.env.CLAUDE_LINK_HOME = home
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0]
  if (flags.scope === true) {
    throw new Error('--scope needs a value')
  }
  selectInstance(flags)
  if (command === 'profile') {
    if (positional[1] === 'enroll') {
      await enroll(flags)
    } else if (positional[1] === 'status') {
      await profileStatus(flags)
    } else {
      print(USAGE)
      process.exitCode = 1
    }
  } else if (command === 'init') {
    await init(flags)
  } else if (command === 'pair-code') {
    await pairCode()
  } else if (command === 'join') {
    await join(positional, flags)
  } else if (command === 'peer') {
    await peer(flags)
  } else if (command === 'serve') {
    await serve(flags)
  } else if (command === 'status') {
    await status()
  } else if (command === 'publish') {
    await publish(flags)
  } else if (command === 'install-mod' || command === 'uninstall-mod') {
    await setModLoaded(positional, command === 'install-mod')
  } else {
    print(USAGE)
    process.exitCode = command && command !== 'help' ? 1 : 0
  }
}

main().catch(error => {
  if (error instanceof ProfileError) {
    error.exitCode = ExitCode.DoNotRestart
  }
  debug.error(error)
  // Let a log file stream flush before exiting.
  setTimeout(() => process.exit(error.exitCode ?? ExitCode.Failure), 100)
})
