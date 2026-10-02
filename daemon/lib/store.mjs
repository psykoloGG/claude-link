import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, watch } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ID_PATTERN, LINK_VERSION, claudeHome, homeDirectory, linkHome } from './config.mjs'
import { debug } from './log.mjs'
import { SLIM_VERSION, clip, convertTranscript, emptyMeta, oneLine, peekCwd } from './slim.mjs'

// Claude encodes a project folder name by replacing every other character
// with "-", so a valid one only has these characters.
export const DIR_PATTERN = /^[A-Za-z0-9_-]{1,200}$/

const FINGERPRINT_TAIL_BYTES = 4096
const MAX_RANGE_BYTES = 64 * 1024 * 1024
const SAVE_DELAY_MS = 5000
const APP_TITLES_REFRESH_MS = 2 * 60 * 1000
const REPO_REFRESH_MS = 10 * 60 * 1000
const LIVE_TTL_MS = 3 * 60 * 1000
const BUILTIN_EXCLUDES = ['/private/var/folders/**', '/var/folders/**', '/private/tmp/**', '/tmp/**', 'appdata/local/temp/**']

export function chatKey(origin, dir, id) {
  return `${origin}/${dir}/${id}`
}

export function isValidChat(origin, dir, id) {
  return ID_PATTERN.test(origin ?? '') && DIR_PATTERN.test(dir ?? '') && ID_PATTERN.test(id ?? '')
}

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

// A project's identity across machines: its path relative to the home folder,
// so C:\Users\you\Desktop\X and /Users/you/Desktop/X are the same project.
// Worktree chats count toward the project they were made from.
export function projectInfo(cwd, home) {
  const folder = normalizePath(cwd).replace(/\/\.claude\/worktrees\/[^/]+$/, '')
  const homeFolder = normalizePath(home)
  const isInHome = homeFolder && folder.toLowerCase().startsWith(`${homeFolder.toLowerCase()}/`)
  const key = (isInHome ? folder.slice(homeFolder.length + 1) : folder).toLowerCase()
  const label = (folder.split('/').filter(Boolean).pop() ?? '').replace(/^\./, '') || folder
  return { key, label }
}

function compileExcludes(patterns) {
  return patterns
    .filter(pattern => typeof pattern === 'string' && pattern.trim())
    .map(pattern => {
      const escaped = pattern.trim().toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&')
      const source = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
      return new RegExp(`^${source}$`)
    })
}

function normalizeRepo(url) {
  const trimmed = String(url ?? '').trim().replace(/\.git$/, '')
  if (!trimmed) {
    return ''
  }
  const scpStyle = /^[^@\s/]+@([^:\s]+):(.+)$/.exec(trimmed)
  if (scpStyle) {
    return `${scpStyle[1]}/${scpStyle[2]}`.toLowerCase()
  }
  try {
    const parsed = new URL(trimmed)
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}

function gitRemote(cwd) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      resolve(error ? '' : normalizeRepo(stdout))
    })
  })
}

function appSessionsDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions')
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude-code-sessions')
}

async function listNames(folder, wantDirectories) {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true })
    return entries.filter(entry => (wantDirectories ? entry.isDirectory() : entry.isFile())).map(entry => entry.name)
  } catch {
    return []
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(value))
  await fs.rename(temp, file)
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function text(value, maxLength) {
  return clip(oneLine(value), maxLength)
}

function count(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

// Peers are paired machines, but their meta still gets the same shape and
// limits as ours before it is stored or shown.
function sanitizeMeta(meta) {
  const source = meta && typeof meta === 'object' ? meta : {}
  return {
    title: text(source.title, 200) || 'Untitled chat',
    cwd: text(source.cwd, 1000),
    project: text(source.project, 1000).toLowerCase(),
    label: text(source.label, 200),
    repo: text(source.repo, 300).toLowerCase(),
    branch: text(source.branch, 200),
    firstAt: count(source.firstAt),
    lastAt: count(source.lastAt),
    prompts: count(source.prompts),
    replies: count(source.replies),
    archived: source.archived === true,
    entrypoint: text(source.entrypoint, 40),
  }
}

// Holds every chat this machine can show: its own (slimmed from the Claude
// transcripts) and the copies synced from linked machines. All of them live
// under ~/.claude-link/chats/<machine id>/<project folder>/<session id>.jsonl.
export class ChatStore {
  constructor(config) {
    this.config = config
    this.selfId = config.machineId
    this.home = homeDirectory(config)
    this.root = linkHome()
    this.chatsRoot = path.join(this.root, 'chats')
    this.ownStateFile = path.join(this.root, 'state', 'own.json')
    this.projectsDir = path.join(claudeHome(config), 'projects')
    this.sessionsDir = path.join(claudeHome(config), 'sessions')
    this.excludes = compileExcludes([...BUILTIN_EXCLUDES, ...(config.exclude ?? [])])
    this.catalog = new Map()
    this.machines = new Map()
    this.live = new Map()
    this.ownState = {}
    this.fileStates = new Map()
    this.locks = new Map()
    this.dirtyOrigins = new Set()
    this.isOwnStateDirty = false
    this.saveTimer = null
    this.appTitles = new Map()
    this.appTitlesAt = 0
    this.appFiles = new Map()
    this.repos = new Map()
    this.scanPromise = null
    this.isRescanWanted = false
    this.indexing = { done: 0, total: 0, isRunning: false }
    this.watcher = null
  }

  async init() {
    await fs.mkdir(this.chatsRoot, { recursive: true, mode: 0o700 })
    this.machines.set(this.selfId, this.selfInfo())
    this.ownState = await readJson(this.ownStateFile, {})
    for (const [key, state] of Object.entries(this.ownState)) {
      const [dir, id] = key.split('/')
      if (!state.isExcluded && isValidChat(this.selfId, dir, id)) {
        this.catalog.set(chatKey(this.selfId, dir, id), { origin: this.selfId, dir, id, gen: state.gen, raw: state.meta })
      }
    }
    for (const origin of await listNames(this.chatsRoot, true)) {
      if (origin === this.selfId || !ID_PATTERN.test(origin)) {
        continue
      }
      const machine = await readJson(path.join(this.chatsRoot, origin, 'machine.json'), null)
      if (machine) {
        this.machines.set(origin, machine)
      }
      const index = await readJson(path.join(this.chatsRoot, origin, 'index.json'), { chats: {} })
      for (const [key, entry] of Object.entries(index.chats ?? {})) {
        const [dir, id] = key.split('/')
        if (isValidChat(origin, dir, id)) {
          this.catalog.set(chatKey(origin, dir, id), { origin, dir, id, gen: count(entry.gen), meta: sanitizeMeta(entry.meta) })
        }
      }
    }
  }

  selfInfo() {
    return {
      machineId: this.selfId,
      name: this.config.machineName,
      platform: process.platform,
      home: this.home,
      version: LINK_VERSION,
    }
  }

  machineName(origin) {
    return this.machines.get(origin)?.name ?? 'Unknown machine'
  }

  chatPath(origin, dir, id) {
    if (!isValidChat(origin, dir, id)) {
      throw new Error('Invalid chat address')
    }
    return path.join(this.chatsRoot, origin, dir, `${id}.jsonl`)
  }

  async withLock(key, task) {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(task)
    this.locks.set(key, run)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === run) {
        this.locks.delete(key)
      }
    }
  }

  isExcluded(cwd) {
    if (!cwd) {
      return false
    }
    const { key } = projectInfo(cwd, this.home)
    return this.excludes.some(pattern => pattern.test(key))
  }

  // ---- This machine's own chats ----

  // Resolves with how many chats changed, which is what tells the daemon to
  // sync right away instead of waiting for the next interval.
  scanOwn() {
    if (this.scanPromise) {
      this.isRescanWanted = true
      return this.scanPromise
    }
    this.scanPromise = (async () => {
      let changed = 0
      try {
        do {
          this.isRescanWanted = false
          changed += await this.scanOwnOnce()
        } while (this.isRescanWanted)
      } finally {
        this.scanPromise = null
      }
      return changed
    })()
    return this.scanPromise
  }

  async scanOwnOnce() {
    const candidates = []
    for (const dir of await listNames(this.projectsDir, true)) {
      if (!DIR_PATTERN.test(dir)) {
        continue
      }
      for (const name of await listNames(path.join(this.projectsDir, dir), false)) {
        const id = name.endsWith('.jsonl') ? name.slice(0, -6) : ''
        if (!ID_PATTERN.test(id)) {
          continue
        }
        const source = path.join(this.projectsDir, dir, name)
        const stat = await fs.stat(source).catch(() => null)
        if (stat) {
          candidates.push({ dir, id, source, stat })
        }
      }
    }
    // Newest first, so recent chats are ready while old ones still index.
    candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    this.indexing = { done: 0, total: candidates.length, isRunning: true }
    let changed = 0
    for (const candidate of candidates) {
      try {
        if (await this.refreshOwn(candidate)) {
          changed += 1
        }
      } catch (error) {
        debug.warn(`Could not index ${candidate.dir}/${candidate.id}:`, error)
      }
      this.indexing.done += 1
    }
    this.indexing.isRunning = false
    await Promise.all([this.refreshAppTitles(), this.refreshRepos()])
    if (changed > 0) {
      this.scheduleSave()
    }
    return changed
  }

  async refreshOwn({ dir, id, source, stat }) {
    const key = `${dir}/${id}`
    let state = this.ownState[key]
    if (state?.isExcluded) {
      if (this.isExcluded(state.cwd)) {
        return false
      }
      state = null
    }
    if (!state) {
      const cwd = await peekCwd(source)
      if (this.isExcluded(cwd)) {
        this.ownState[key] = { isExcluded: true, cwd }
        this.isOwnStateDirty = true
        return false
      }
    }
    const slimPath = this.chatPath(this.selfId, dir, id)
    const hasSlimFile = state ? await fs.access(slimPath).then(() => true, () => false) : false
    const needsReset = !hasSlimFile || state.slimVersion !== SLIM_VERSION || stat.size < state.parsedBytes
    if (!needsReset && stat.size === state.parsedBytes) {
      return false
    }
    if (needsReset) {
      state = { gen: (state?.gen ?? 0) + 1, slimVersion: SLIM_VERSION, parsedBytes: 0, meta: emptyMeta() }
    }
    await this.withLock(chatKey(this.selfId, dir, id), async () => {
      await fs.mkdir(path.dirname(slimPath), { recursive: true })
      const handle = await fs.open(slimPath, needsReset ? 'w' : 'a')
      try {
        state.parsedBytes = await convertTranscript(source, state.parsedBytes, state.meta, chunk => handle.appendFile(chunk))
      } finally {
        await handle.close()
      }
      this.fileStates.delete(chatKey(this.selfId, dir, id))
    })
    if (this.isExcluded(state.meta.cwd)) {
      await fs.rm(slimPath, { force: true })
      this.ownState[key] = { isExcluded: true, cwd: state.meta.cwd }
      this.catalog.delete(chatKey(this.selfId, dir, id))
      this.isOwnStateDirty = true
      return false
    }
    this.ownState[key] = state
    this.catalog.set(chatKey(this.selfId, dir, id), { origin: this.selfId, dir, id, gen: state.gen, raw: state.meta })
    this.isOwnStateDirty = true
    return true
  }

  // Desktop app sidebar titles (and archived state), which win over the
  // titles inside the transcript since they reflect renames.
  async refreshAppTitles() {
    if (Date.now() - this.appTitlesAt < APP_TITLES_REFRESH_MS) {
      return
    }
    this.appTitlesAt = Date.now()
    const root = appSessionsDir()
    const titles = new Map()
    for (const account of await listNames(root, true)) {
      for (const organization of await listNames(path.join(root, account), true)) {
        const folder = path.join(root, account, organization)
        for (const name of await listNames(folder, false)) {
          if (!name.startsWith('local_') || !name.endsWith('.json')) {
            continue
          }
          const record = await this.readAppSession(path.join(folder, name))
          if (record) {
            titles.set(record.id, record)
          }
        }
      }
    }
    this.appTitles = titles
  }

  async readAppSession(file) {
    const stat = await fs.stat(file).catch(() => null)
    if (!stat) {
      return null
    }
    const cached = this.appFiles.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.record
    }
    const data = await readJson(file, null)
    // "New session" is the app's placeholder until it names the chat.
    const title = data?.title === 'New session' ? '' : text(data?.title, 200)
    const record = ID_PATTERN.test(data?.cliSessionId ?? '')
      ? { id: data.cliSessionId, title, isArchived: data.isArchived === true }
      : null
    this.appFiles.set(file, { mtimeMs: stat.mtimeMs, record })
    return record
  }

  async refreshRepos() {
    const folders = new Set()
    for (const chat of this.catalog.values()) {
      if (chat.origin === this.selfId && chat.raw?.cwd) {
        folders.add(chat.raw.cwd)
      }
    }
    for (const folder of folders) {
      await this.repoFor(folder)
    }
  }

  async repoFor(folder) {
    const cached = this.repos.get(folder)
    if (cached && Date.now() - cached.checkedAt < REPO_REFRESH_MS) {
      return cached.repo
    }
    const repo = await gitRemote(folder)
    this.repos.set(folder, { repo, checkedAt: Date.now() })
    return repo
  }

  // How a chat is described to peers and to the mod.
  describe(chat) {
    if (chat.origin !== this.selfId) {
      return chat.meta
    }
    const raw = chat.raw ?? emptyMeta()
    const app = this.appTitles.get(chat.id)
    const { key, label } = projectInfo(raw.cwd, this.home)
    return sanitizeMeta({
      title: raw.customTitle || app?.title || raw.aiTitle || raw.firstPrompt,
      cwd: raw.cwd,
      project: key,
      label,
      repo: this.repos.get(raw.cwd)?.repo ?? '',
      branch: raw.branch,
      firstAt: raw.firstAt,
      lastAt: raw.lastAt,
      prompts: raw.prompts,
      replies: raw.replies,
      archived: app?.isArchived === true,
      entrypoint: raw.entrypoint,
    })
  }

  async projectFor(cwd) {
    const { key, label } = projectInfo(cwd, this.home)
    return { key, label, repo: cwd ? await this.repoFor(cwd) : '' }
  }

  // Claude sessions open on this machine right now, from the registry each
  // running Claude Code process keeps under ~/.claude/sessions.
  async liveSessions() {
    const sessions = []
    for (const name of await listNames(this.sessionsDir, false)) {
      if (!name.endsWith('.json')) {
        continue
      }
      const data = await readJson(path.join(this.sessionsDir, name), null)
      if (!ID_PATTERN.test(data?.sessionId ?? '') || !isAlive(data.pid)) {
        continue
      }
      sessions.push({ id: data.sessionId, status: text(data.status, 40), name: text(data.name, 200) })
    }
    return sessions
  }

  recordLive(origin, sessions) {
    if (!Array.isArray(sessions)) {
      return
    }
    const byId = new Map()
    for (const session of sessions.slice(0, 200)) {
      if (ID_PATTERN.test(session?.id ?? '')) {
        byId.set(session.id, { status: text(session.status, 40), name: text(session.name, 200) })
      }
    }
    this.live.set(origin, { at: Date.now(), sessions: byId })
  }

  liveStatus(origin, id) {
    const entry = this.live.get(origin)
    if (!entry || Date.now() - entry.at > LIVE_TTL_MS) {
      return ''
    }
    return entry.sessions.get(id)?.status ?? ''
  }

  // A chat that is streaming writes every few moments, so the first change
  // starts the countdown and later ones ride along rather than restarting it.
  watchOwn(onChange) {
    let timer = null
    const schedule = () => {
      if (timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        onChange()
      }, 1500)
    }
    try {
      this.watcher = watch(this.projectsDir, { recursive: true }, (eventType, filename) => {
        const name = String(filename ?? '')
        if (name.endsWith('.jsonl') && name.split(/[\\/]/).length === 2) {
          schedule()
        }
      })
      this.watcher.on('error', error => debug.warn('Transcript watcher stopped:', error))
    } catch (error) {
      debug.warn('Could not watch the Claude projects folder, relying on the periodic scan:', error)
    }
  }

  // ---- Files and sync ----

  async fileState(origin, dir, id) {
    const key = chatKey(origin, dir, id)
    const file = this.chatPath(origin, dir, id)
    const stat = await fs.stat(file).catch(() => null)
    if (!stat) {
      return { size: 0, fp: '0:' }
    }
    const cached = this.fileStates.get(key)
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached
    }
    const state = { size: stat.size, mtimeMs: stat.mtimeMs, fp: await fingerprintAt(file, stat.size) }
    this.fileStates.set(key, state)
    return state
  }

  // A slice of a chat file that ends on a line boundary, so the receiver only
  // ever holds whole records. When the receiver's copy does not match ours at
  // `from` (the file was rebuilt), the slice starts over from zero.
  async readRange(origin, dir, id, from, prefixFp, maxBytes) {
    const file = this.chatPath(origin, dir, id)
    const { size, fp } = await this.fileState(origin, dir, id)
    let start = Number.isInteger(from) && from >= 0 ? from : 0
    if (start > size || (start > 0 && prefixFp !== (await fingerprintAt(file, start)))) {
      start = 0
    }
    if (start >= size) {
      return { size, fp, start, data: '' }
    }
    let limit = Math.max(64 * 1024, Math.min(count(maxBytes) || 8 * 1024 * 1024, MAX_RANGE_BYTES))
    const handle = await fs.open(file, 'r')
    try {
      while (true) {
        const length = Math.min(limit, size - start)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, start)
        const isAtEnd = start + bytesRead >= size
        const cut = isAtEnd ? bytesRead : buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1
        if (cut > 0 || limit >= MAX_RANGE_BYTES) {
          return { size, fp, start, data: buffer.toString('utf8', 0, cut > 0 ? cut : bytesRead) }
        }
        limit *= 2
      }
    } finally {
      await handle.close()
    }
  }

  async writeChunk(origin, dir, id, start, data, { gen, totalSize }) {
    if (origin === this.selfId) {
      throw new Error('A machine is the only writer of its own chats')
    }
    const key = chatKey(origin, dir, id)
    const file = this.chatPath(origin, dir, id)
    return this.withLock(key, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const current = (await fs.stat(file).catch(() => null))?.size ?? 0
      if (start > current) {
        throw new Error('Chunk does not continue the local copy')
      }
      if (start < current) {
        await fs.truncate(file, start)
      }
      await fs.appendFile(file, data, 'utf8')
      this.fileStates.delete(key)
      const state = await this.fileState(origin, dir, id)
      const chat = this.catalog.get(key)
      if (chat && state.size >= totalSize && chat.gen !== gen) {
        chat.gen = gen
        this.markDirty(origin)
      }
      return state
    })
  }

  recordMachine(info) {
    if (!info || !ID_PATTERN.test(info.machineId ?? '') || info.machineId === this.selfId) {
      return
    }
    const machine = {
      machineId: info.machineId,
      name: text(info.name, 80) || 'Unknown machine',
      platform: text(info.platform, 20),
      home: text(info.home, 500),
      version: text(info.version, 20),
    }
    const previous = this.machines.get(machine.machineId)
    this.machines.set(machine.machineId, machine)
    if (JSON.stringify(previous) !== JSON.stringify(machine)) {
      writeJson(path.join(this.chatsRoot, machine.machineId, 'machine.json'), machine).catch(error => {
        debug.warn('Could not save machine info:', error)
      })
    }
  }

  // Meta for a chat another machine owns. The generation only moves forward
  // once its data has fully arrived (writeChunk), so a broken transfer is
  // retried rather than mistaken for a finished one.
  recordPeerEntry(entry) {
    if (!isValidChat(entry?.origin, entry?.dir, entry?.id) || entry.origin === this.selfId) {
      return false
    }
    const key = chatKey(entry.origin, entry.dir, entry.id)
    const existing = this.catalog.get(key)
    const meta = sanitizeMeta(entry.meta)
    if (existing && count(entry.gen) < existing.gen) {
      return false
    }
    if (existing) {
      if (JSON.stringify(existing.meta) !== JSON.stringify(meta)) {
        existing.meta = meta
        this.markDirty(entry.origin)
      }
    } else {
      this.catalog.set(key, { origin: entry.origin, dir: entry.dir, id: entry.id, gen: 0, meta })
      this.markDirty(entry.origin)
    }
    return true
  }

  // What the other side needs to send so our copy matches its entry.
  async planTransfer(entry) {
    if (!isValidChat(entry?.origin, entry?.dir, entry?.id) || entry.origin === this.selfId) {
      return null
    }
    const local = this.catalog.get(chatKey(entry.origin, entry.dir, entry.id))
    const localGen = local?.gen ?? 0
    const remoteGen = count(entry.gen)
    if (remoteGen < localGen) {
      return null
    }
    const state = await this.fileState(entry.origin, entry.dir, entry.id)
    if (remoteGen > localGen) {
      return { from: 0, prefixFp: '' }
    }
    if (count(entry.size) > state.size) {
      return { from: state.size, prefixFp: state.fp }
    }
    if (count(entry.size) === state.size && entry.fp !== state.fp) {
      return { from: 0, prefixFp: '' }
    }
    return null
  }

  async manifest(excludeOrigin) {
    const entries = []
    for (const chat of this.catalog.values()) {
      if (chat.origin === excludeOrigin) {
        continue
      }
      const state = await this.fileState(chat.origin, chat.dir, chat.id)
      if (state.size === 0) {
        continue
      }
      entries.push({ origin: chat.origin, dir: chat.dir, id: chat.id, gen: chat.gen, size: state.size, fp: state.fp, meta: this.describe(chat) })
    }
    const machines = [...this.machines.values()].filter(machine => machine.machineId !== excludeOrigin)
    return { machines, entries }
  }

  markDirty(origin) {
    if (origin !== this.selfId) {
      this.dirtyOrigins.add(origin)
    }
    this.scheduleSave()
  }

  scheduleSave() {
    if (this.saveTimer) {
      return
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush().catch(error => debug.warn('Could not save the chat index:', error))
    }, SAVE_DELAY_MS)
  }

  async flush() {
    if (this.isOwnStateDirty) {
      this.isOwnStateDirty = false
      await writeJson(this.ownStateFile, this.ownState)
    }
    const origins = [...this.dirtyOrigins]
    this.dirtyOrigins.clear()
    for (const origin of origins) {
      const chats = {}
      for (const chat of this.catalog.values()) {
        if (chat.origin === origin) {
          chats[`${chat.dir}/${chat.id}`] = { gen: chat.gen, meta: chat.meta }
        }
      }
      await writeJson(path.join(this.chatsRoot, origin, 'index.json'), { chats })
    }
  }

  close() {
    this.watcher?.close()
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    return this.flush()
  }
}

// Size plus a hash of the bytes just before it: enough to tell whether two
// copies of an append-only file agree up to that point.
export async function fingerprintAt(file, size) {
  if (size <= 0) {
    return '0:'
  }
  const length = Math.min(FINGERPRINT_TAIL_BYTES, size)
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return `${size}:${createHash('sha256').update(buffer).digest('hex').slice(0, 32)}`
  } finally {
    await handle.close()
  }
}
