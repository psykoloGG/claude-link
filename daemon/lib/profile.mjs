import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// Opt-in support for more than one Claude Code profile on a machine (for
// example the ones claude-multiprofile sets up, each with its own
// CLAUDE_CONFIG_DIR). Every enrolled profile gets its own Claude Link
// instance: its own folder, link key, machine id, local token, ports and
// launch label, and it only reads that profile's Claude Code folder. The
// default instance (~/.claude-link, ~/.claude) is untouched.
//
// Instances are kept apart to prevent mix-ups, not as a security boundary:
// programs running as the same user can read each other's files anyway.

// The sync scope is the identity two machines agree on for a profile. It is
// chosen explicitly at enrollment, never taken from a display name or path,
// so renaming a profile or keeping it at a different path on the other
// machine does not change which chats it pairs with.
export const SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
const RESERVED_SCOPES = new Set(['default', 'profiles', 'app', 'mod', 'chats', 'state'])

export const REGISTRY_VERSION = 1
const PORT_BASE_FIRST = 47610
const PORT_BASE_STEP = 10
const PORT_BASE_LAST = 47990

export class ProfileError extends Error {}

export function validateScope(scope) {
  if (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope) || RESERVED_SCOPES.has(scope)) {
    throw new ProfileError('A sync scope is 1-32 lowercase letters, digits or dashes (not "default"), the same on every machine, e.g. "work"')
  }
  return scope
}

// Where named instances live, beside (not inside) the default ~/.claude-link,
// so removing one never touches the other.
export function profilesRoot() {
  return process.env.CLAUDE_LINK_PROFILES_HOME || path.join(os.homedir(), '.claude-link-profiles')
}

export function profileHome(scope) {
  return path.join(profilesRoot(), validateScope(scope))
}

export function launchLabel(scope) {
  return scope ? `com.claude-link.daemon.${validateScope(scope)}` : 'com.claude-link.daemon'
}

// The Claude Code folder a session without CLAUDE_CONFIG_DIR uses.
export function defaultCodeRoot() {
  return path.join(os.homedir(), '.claude')
}

export function defaultDesktopDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude')
  }
  return path.join(os.homedir(), '.config', 'Claude')
}

export function expandHome(value) {
  const text = String(value ?? '')
  if (text === '~') {
    return os.homedir()
  }
  return text.startsWith('~/') ? path.join(os.homedir(), text.slice(2)) : text
}

// The real location of a folder, with symlinks and aliases resolved, or ''
// when it does not exist (or is not a folder).
export async function canonicalDir(value) {
  if (!value) {
    return ''
  }
  try {
    const real = await fs.realpath(path.resolve(expandHome(value)))
    const stat = await fs.stat(real)
    return stat.isDirectory() ? real : ''
  } catch {
    return ''
  }
}

function comparable(folder) {
  const normalized = path.resolve(folder)
  // macOS and Windows folders are case-insensitive by default.
  return process.platform === 'linux' ? normalized : normalized.toLowerCase()
}

// True when two canonical folders are the same or one sits inside the other.
export function rootsOverlap(left, right) {
  if (!left || !right) {
    return false
  }
  const [a, b] = [comparable(left), comparable(right)]
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)
}

// ---- claude-multiprofile registry (read only) ----

export function registryPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'claude-multiprofile', 'profiles.json')
}

// Looks up one explicitly named profile. Claude Link never writes the
// registry, never enrolls profiles from it on its own, and refuses to guess
// when the file is missing, unreadable or a version it does not know.
export async function readRegistryProfile(name) {
  const file = registryPath()
  let text = ''
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    throw new ProfileError('No claude-multiprofile registry found. Pass --code-dir (and --desktop-dir) instead.')
  }
  let registry = null
  try {
    registry = JSON.parse(text)
  } catch {
    throw new ProfileError('The claude-multiprofile registry is not valid JSON; not guessing. Fix it with claude-multiprofile, or pass --code-dir.')
  }
  if (!registry || typeof registry !== 'object' || registry.version !== REGISTRY_VERSION || !Array.isArray(registry.profiles)) {
    throw new ProfileError(`The claude-multiprofile registry is not version ${REGISTRY_VERSION}; not guessing. Pass --code-dir instead.`)
  }
  const matches = registry.profiles.filter(entry => entry && typeof entry === 'object' && entry.name === name)
  if (matches.length === 0) {
    throw new ProfileError('That profile is not in the claude-multiprofile registry.')
  }
  if (matches.length > 1) {
    throw new ProfileError('The claude-multiprofile registry lists that profile more than once; not guessing.')
  }
  const entry = matches[0]
  const codeDir = typeof entry.code?.configDir === 'string' ? entry.code.configDir : ''
  const desktopDir = typeof entry.desktop?.dataDir === 'string' ? entry.desktop.dataDir : ''
  if (!codeDir) {
    // A Desktop-only profile shares the default Claude Code folder, so its
    // Code chats cannot be told apart from the default ones.
    throw new ProfileError('Unsupported: that profile has no isolated Claude Code folder (Desktop only). Add Code to it in claude-multiprofile first.')
  }
  return { codeDir, desktopDir }
}

// ---- Enrollment ----

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

// Configs of the other enrolled instances, to keep roots and ports apart.
export async function otherInstances(exceptScope) {
  const configs = []
  let names = []
  try {
    names = await fs.readdir(profilesRoot())
  } catch {
    return configs
  }
  for (const name of names) {
    if (name === exceptScope || !SCOPE_PATTERN.test(name)) {
      continue
    }
    const config = await readJson(path.join(profilesRoot(), name, 'config.json'))
    if (config?.profile) {
      configs.push(config)
    }
  }
  return configs
}

function canBind(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

function portsOf(config) {
  return [config?.localPort, config?.peerPort, config?.discoveryPort].filter(Number.isInteger)
}

export async function pickPorts({ requestedBase, taken }) {
  const isFree = async base => {
    const ports = [base, base + 1, base + 2]
    if (ports.some(port => port < 1024 || port > 65535 || taken.has(port))) {
      return false
    }
    return (await canBind(base)) && (await canBind(base + 1))
  }
  if (requestedBase !== undefined) {
    const base = Number(requestedBase)
    if (!Number.isInteger(base) || !(await isFree(base))) {
      throw new ProfileError('Those ports are taken (by another Claude Link instance or another program). Pick another --port-base.')
    }
    return { localPort: base, peerPort: base + 1, discoveryPort: base + 2 }
  }
  for (let base = PORT_BASE_FIRST; base <= PORT_BASE_LAST; base += PORT_BASE_STEP) {
    if (await isFree(base)) {
      return { localPort: base, peerPort: base + 1, discoveryPort: base + 2 }
    }
  }
  throw new ProfileError('No free port range found. Pass --port-base.')
}

// Works out what an enrollment binds to and checks it against the default
// instance and every other enrolled profile. Both roots must exist and be
// verifiable; nothing is created.
export async function resolveEnrollment({ scope, profileName, codeDir, desktopDir, defaultConfig, portBase }) {
  validateScope(scope)
  if (profileName && codeDir) {
    throw new ProfileError('Pass either --profile or --code-dir, not both.')
  }
  let source = 'paths'
  let rawCode = codeDir
  let rawDesktop = desktopDir
  if (profileName) {
    if (desktopDir) {
      throw new ProfileError('--desktop-dir comes from the registry when --profile is used.')
    }
    ;({ codeDir: rawCode, desktopDir: rawDesktop } = await readRegistryProfile(profileName))
    source = 'registry'
  }
  if (!rawCode) {
    throw new ProfileError('Enrollment needs --profile <name> or --code-dir <folder>.')
  }
  const code = await canonicalDir(rawCode)
  if (!code) {
    throw new ProfileError('The profile\'s Claude Code folder does not exist. Start that profile once, then enroll it.')
  }
  const desktop = rawDesktop ? await canonicalDir(rawDesktop) : ''
  if (rawDesktop && !desktop) {
    throw new ProfileError('The profile\'s Desktop data folder does not exist. Start that profile\'s Desktop app once, or leave it out for a Code-only profile.')
  }
  const defaultRoots = [await canonicalDir(defaultCodeRoot()), await canonicalDir(defaultConfig?.claudeDir)].filter(Boolean)
  if (defaultRoots.some(root => rootsOverlap(root, code)) || rootsOverlap(code, path.resolve(defaultCodeRoot()))) {
    throw new ProfileError('That Claude Code folder is (or overlaps) the default one; the default instance already covers it.')
  }
  const defaultDesktop = await canonicalDir(defaultDesktopDir())
  if (desktop && rootsOverlap(desktop, defaultDesktop)) {
    throw new ProfileError('That Desktop data folder is (or overlaps) the default Desktop app\'s; it would mix default titles in.')
  }
  const taken = new Set(portsOf(defaultConfig ?? { localPort: 47600, peerPort: 47601, discoveryPort: 47602 }))
  for (const other of await otherInstances(scope)) {
    for (const port of portsOf(other)) {
      taken.add(port)
    }
    if (rootsOverlap(other.profile.codeDir, code) || (desktop && rootsOverlap(other.profile.desktopDir, desktop))) {
      throw new ProfileError(`That folder is already enrolled (or overlaps one) under scope "${other.profile.scope}".`)
    }
  }
  const ports = await pickPorts({ requestedBase: portBase, taken })
  return {
    profile: {
      scope,
      codeDir: code,
      desktopDir: desktop || null,
      // The Desktop app keeps its Code session titles in this subfolder of
      // its data folder, the same layout as the default app.
      desktopSessionsDir: desktop ? path.join(desktop, 'claude-code-sessions') : null,
      source,
      registryName: profileName || null,
    },
    ports,
  }
}

// Run before a named instance serves: the folder it was enrolled with must
// still be there, at the same real location, and not become the default one.
export async function verifyBinding(config) {
  const profile = config.profile
  if (!profile) {
    return
  }
  validateScope(profile.scope)
  const code = await canonicalDir(config.claudeDir)
  if (!code || code !== profile.codeDir || config.claudeDir !== profile.codeDir) {
    throw new ProfileError('This profile\'s Claude Code folder is missing or moved. Re-enroll it with "claude-link profile enroll".')
  }
  if (rootsOverlap(code, await canonicalDir(defaultCodeRoot()))) {
    throw new ProfileError('This profile\'s Claude Code folder now overlaps the default one; refusing to serve.')
  }
  if (profile.desktopDir && (await canonicalDir(profile.desktopDir)) !== profile.desktopDir) {
    throw new ProfileError('This profile\'s Desktop data folder is missing or moved. Re-enroll it, or enroll it Code-only.')
  }
  const reserved = [47600, 47601, 47602]
  if ([config.localPort, config.peerPort, config.discoveryPort].some(port => reserved.includes(port))) {
    throw new ProfileError('A named profile cannot use the default instance\'s ports.')
  }
}

// Which Claude Code folder a client (the mod, inside a Claude session) says it
// belongs to, as sent in the X-Claude-Link-Root header: its CLAUDE_CONFIG_DIR,
// URI-encoded, or empty for the default ~/.claude.
export const ROOT_HEADER = 'x-claude-link-root'

// Decides whether a local API request comes from the profile this instance
// serves. The default instance still answers mods that predate the header,
// so existing setups keep working; a named instance never does.
export async function clientMatches(config, boundRoot, headerValue) {
  if (headerValue === undefined) {
    return !config.profile
  }
  let claimed = ''
  try {
    claimed = decodeURIComponent(String(headerValue))
  } catch {
    return false
  }
  const root = await canonicalDir(claimed || defaultCodeRoot())
  return Boolean(root) && root === boundRoot
}
