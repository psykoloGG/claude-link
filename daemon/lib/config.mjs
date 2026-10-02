import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LINK_VERSION = '0.2.0'

export const Ports = Object.freeze({
  Local: 47600,
  Peer: 47601,
  Discovery: 47602,
})

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PAIR_CODE_PREFIX = 'clink1.'

function defaults() {
  return {
    localPort: Ports.Local,
    peerPort: Ports.Peer,
    peerHost: '0.0.0.0',
    discoveryPort: Ports.Discovery,
    discovery: true,
    autoUpdate: true,
    syncIntervalSeconds: 60,
    exclude: [],
    peers: [],
  }
}

export function linkHome() {
  return process.env.CLAUDE_LINK_HOME || path.join(os.homedir(), '.claude-link')
}

export function configPath() {
  return path.join(linkHome(), 'config.json')
}

export function claudeHome(config) {
  return config.claudeDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

export function homeDirectory(config) {
  return config.homeDir || os.homedir()
}

export async function configExists() {
  try {
    await fs.access(configPath())
    return true
  } catch {
    return false
  }
}

export async function loadConfig() {
  let text = ''
  try {
    text = await fs.readFile(configPath(), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`No link config at ${configPath()}. Run "claude-link init --name <this machine>" first.`)
    }
    throw error
  }
  const config = { ...defaults(), ...JSON.parse(text) }
  if (!ID_PATTERN.test(config.machineId ?? '') || !config.linkKey || !config.localToken) {
    throw new Error(`${configPath()} is missing machineId, linkKey or localToken`)
  }
  return config
}

// Written through a temp file so a crash never leaves a half-written config,
// and readable by this user only since it holds the link key.
export async function saveConfig(config) {
  await fs.mkdir(linkHome(), { recursive: true, mode: 0o700 })
  const file = configPath()
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temp, file)
  await fs.chmod(file, 0o600).catch(() => {})
}

export function createConfig({ name, linkKey }) {
  return {
    version: 1,
    machineId: randomUUID(),
    machineName: name,
    linkKey: linkKey ?? randomBytes(32).toString('base64url'),
    localToken: randomBytes(24).toString('base64url'),
    ...defaults(),
  }
}

// Private IPv4 addresses of this machine, home-network ranges first, so the
// other machine tries the likeliest address before VPN or container ones.
export function lanAddresses() {
  const addresses = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) {
        addresses.push(entry.address)
      }
    }
  }
  const rank = address => (address.startsWith('192.168.') ? 0 : address.startsWith('172.') ? 1 : 2)
  return addresses.sort((left, right) => rank(left) - rank(right))
}

function isPrivateAddress(address) {
  const [first, second] = address.split('.').map(Number)
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31)
}

// The pairing code carries the link key itself, so it must only travel
// between the user's own machines (it is shown once, like a password).
export function makePairCode(config) {
  const urls = lanAddresses().map(address => `http://${address}:${config.peerPort}`)
  const payload = { key: config.linkKey, name: config.machineName, id: config.machineId, urls }
  return PAIR_CODE_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function readPairCode(code) {
  const trimmed = (code ?? '').trim()
  if (!trimmed.startsWith(PAIR_CODE_PREFIX)) {
    throw new Error('That is not a Claude Link pairing code')
  }
  const payload = JSON.parse(Buffer.from(trimmed.slice(PAIR_CODE_PREFIX.length), 'base64url').toString('utf8'))
  if (typeof payload.key !== 'string' || typeof payload.name !== 'string' || !Array.isArray(payload.urls)) {
    throw new Error('The pairing code is incomplete')
  }
  return payload
}
