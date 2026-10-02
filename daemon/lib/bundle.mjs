import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { linkHome } from './config.mjs'

// The code every linked machine runs: the daemon (app/) and the Claude Code
// mod (mod/), both under ~/.claude-link. "publish" installs a build from the
// project folder; the newest build then travels over the link like a chat,
// so every machine ends up on the same version.
export const BundlePart = Object.freeze({
  App: 'app',
  Mod: 'mod',
})

const MAX_FILES = 300
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const FILE_PATTERN = /^(app|mod)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/
const SKIPPED_FOLDERS = new Set(['test', 'tests', 'node_modules'])

// Tests and dependencies never travel, nor what Claude Code writes into a mod
// folder when it loads it (its type files and tsconfig.json).
function isSkipped(part, relative) {
  const segments = relative.split('/')
  if (segments.some(segment => SKIPPED_FOLDERS.has(segment)) || segments.at(-1) === '.DS_Store') {
    return true
  }
  return part === BundlePart.Mod && (relative === 'tsconfig.json' || relative.startsWith('.claude-plugin/types'))
}

async function walk(root, part, relative = '') {
  let entries = []
  try {
    entries = await fs.readdir(path.join(root, ...relative.split('/').filter(Boolean)), { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (isSkipped(part, child)) {
      continue
    }
    if (entry.isDirectory()) {
      files.push(...(await walk(root, part, child)))
    } else if (entry.isFile()) {
      files.push(child)
    }
  }
  return files
}

async function readTree(root, part) {
  const files = []
  for (const relative of await walk(root, part)) {
    files.push({ path: `${part}/${relative}`, content: await fs.readFile(path.join(root, ...relative.split('/')), 'utf8') })
  }
  return files
}

export function bundleInfoPath() {
  return path.join(linkHome(), 'bundle.json')
}

export async function readBundleInfo() {
  try {
    const info = JSON.parse(await fs.readFile(bundleInfoPath(), 'utf8'))
    return { publishedAt: Number(info.publishedAt) || 0, hash: String(info.hash ?? '') }
  } catch {
    return { publishedAt: 0, hash: '' }
  }
}

// A build from the project folder: daemon/ becomes app/, mod/ stays mod/.
export async function sourceFiles(projectRoot) {
  return [...(await readTree(path.join(projectRoot, 'daemon'), BundlePart.App)), ...(await readTree(path.join(projectRoot, 'mod'), BundlePart.Mod))]
}

export async function installedFiles() {
  return [...(await readTree(path.join(linkHome(), BundlePart.App), BundlePart.App)), ...(await readTree(path.join(linkHome(), BundlePart.Mod), BundlePart.Mod))]
}

// Same files, same hash: what decides whether two machines run the same build.
export function bundleHash(files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    hash.update(`${file.path}\0${file.content}\0`)
  }
  return hash.digest('hex').slice(0, 16)
}

export function isNewer(candidate, current) {
  return Boolean(candidate.hash) && candidate.hash !== current.hash && candidate.publishedAt > current.publishedAt
}

// Files from another machine may only land inside app/ and mod/.
export function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    throw new Error('A build must have between 1 and 300 files')
  }
  let total = 0
  for (const file of files) {
    const isPathSafe = typeof file?.path === 'string' && FILE_PATTERN.test(file.path) && !file.path.split('/').some(segment => segment === '.' || segment === '..')
    if (!isPathSafe || typeof file.content !== 'string') {
      throw new Error('A build file has an invalid path or content')
    }
    const size = Buffer.byteLength(file.content)
    total += size
    if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
      throw new Error('A build is larger than allowed')
    }
  }
  if (!files.some(file => file.path === 'app/claude-link.mjs') || !files.some(file => file.path === 'mod/.claude-plugin/plugin.json')) {
    throw new Error('A build needs both the daemon and the mod')
  }
}

// Replaces app/ and mod/ with the build and records it in bundle.json, which
// is what a running daemon watches to restart onto the new code.
export async function installBundle(files, publishedAt) {
  validateFiles(files)
  const wanted = new Set(files.map(file => file.path))
  for (const part of Object.values(BundlePart)) {
    const root = path.join(linkHome(), part)
    for (const relative of await walk(root, part)) {
      if (!wanted.has(`${part}/${relative}`)) {
        await fs.rm(path.join(root, ...relative.split('/')), { force: true })
      }
    }
  }
  for (const file of files) {
    const target = path.join(linkHome(), ...file.path.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.content)
  }
  const info = { publishedAt, hash: bundleHash(files) }
  await fs.writeFile(bundleInfoPath(), JSON.stringify(info))
  return info
}

export function formatBuild(info) {
  if (!info?.hash) {
    return 'none'
  }
  return `${new Date(info.publishedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC (${info.hash.slice(0, 7)})`
}
