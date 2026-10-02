import { timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'

import { readBundleInfo } from './bundle.mjs'
import { LINK_VERSION } from './config.mjs'
import { debug } from './log.mjs'
import { buildTurns, contextBlock, findSnippet, mainBranch, parseSlim, readSlim, turnsToMarkdown } from './render.mjs'
import { clip } from './slim.mjs'

export const ChatFormat = Object.freeze({
  Turns: 'turns',
  Markdown: 'markdown',
  Context: 'context',
})

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const DEFAULT_TURNS = 60
const MAX_TURNS = 400
const TURN_TEXT_LIMIT = 6000
const DEFAULT_MAX_CHARS = 24000
const MIN_MAX_CHARS = 2000
const MAX_MAX_CHARS = 200000
const MAX_SEARCH_HITS = 50
const SYNC_WAIT_MS = 30000

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function isTrue(value) {
  return value === '1' || value === 'true'
}

// The mod's door to the daemon: loopback only, and every request carries the
// local token from config.json. Requests from a browser page (they send an
// Origin header) are refused outright.
export function startLocalApi({ config, store, sync }) {
  const expected = Buffer.from(`Bearer ${config.localToken}`)
  const isAuthorized = request => {
    const given = Buffer.from(String(request.headers.authorization ?? ''))
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  const routes = {
    'GET /api/status': () => status(store, sync),
    'GET /api/chats': query => listChats(store, query),
    'GET /api/chat': query => readChat(store, query),
    'GET /api/search': query => searchChats(store, query),
    'POST /api/sync': async () => {
      await Promise.race([sync.syncAll('manual'), new Promise(resolve => setTimeout(resolve, SYNC_WAIT_MS))])
      return status(store, sync)
    },
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.origin || !isAuthorized(request)) {
        sendJson(response, 401, { error: 'Not authorized' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const route = routes[`${request.method} ${url.pathname}`]
      if (!route) {
        sendJson(response, 404, { error: 'Not found' })
        return
      }
      sendJson(response, 200, await route(url.searchParams))
    } catch (error) {
      debug.warn('Local API request failed:', error)
      sendJson(response, error.statusCode ?? 500, { error: error.message })
    }
  })
  server.listen(config.localPort, '127.0.0.1')
  return server
}

async function status(store, sync) {
  let local = 0
  let remote = 0
  for (const chat of store.catalog.values()) {
    if (chat.origin === store.selfId) {
      local += 1
    } else {
      remote += 1
    }
  }
  return {
    version: LINK_VERSION,
    machine: { id: store.selfId, name: store.config.machineName },
    build: await readBundleInfo(),
    indexing: store.indexing,
    counts: { local, remote },
    peers: sync.peerStatus(),
  }
}

// Folders nested inside a project count as that project, so a chat started in
// a plugin subfolder still shows up at the project root. Short keys such as
// "desktop/personal" are too broad to stand for a project on their own.
export function isSameOrNested(left, right) {
  if (!left || !right) {
    return false
  }
  if (left === right) {
    return true
  }
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left]
  return shorter.split('/').length >= 3 && longer.startsWith(`${shorter}/`)
}

function matchesProject(meta, here) {
  if (!here) {
    return false
  }
  return Boolean((here.repo && meta.repo === here.repo) || isSameOrNested(meta.project, here.key))
}

function summarize(store, chat, here) {
  const meta = store.describe(chat)
  const isLocal = chat.origin === store.selfId
  return {
    ref: chat.id,
    origin: chat.origin,
    id: chat.id,
    machine: isLocal ? store.config.machineName : store.machineName(chat.origin),
    isLocal,
    title: meta.title,
    project: meta.label,
    projectKey: meta.project,
    cwd: meta.cwd,
    branch: meta.branch,
    firstAt: meta.firstAt,
    lastAt: meta.lastAt,
    prompts: meta.prompts,
    isArchived: meta.archived,
    live: isLocal ? '' : store.liveStatus(chat.origin, chat.id),
    isHere: matchesProject(meta, here),
  }
}

function originFilter(store, value) {
  const wanted = String(value ?? '').trim().toLowerCase()
  if (!wanted || wanted === 'all') {
    return () => true
  }
  return chat => chat.origin === wanted || store.machineName(chat.origin).toLowerCase() === wanted
}

// Chats the request asks about, newest first, each with its summary.
async function candidates(store, query) {
  const here = query.get('cwd') ? await store.projectFor(query.get('cwd')) : null
  const includeLocal = isTrue(query.get('local'))
  const includeArchived = isTrue(query.get('archived'))
  const matchesOrigin = originFilter(store, query.get('machine'))
  const entries = []
  for (const chat of store.catalog.values()) {
    if ((chat.origin === store.selfId && !includeLocal) || !matchesOrigin(chat)) {
      continue
    }
    const summary = summarize(store, chat, here)
    if (summary.isArchived && !includeArchived) {
      continue
    }
    entries.push({ chat, summary })
  }
  entries.sort((left, right) => right.summary.lastAt - left.summary.lastAt)
  return { here, entries }
}

async function listChats(store, query) {
  const { here, entries } = await candidates(store, query)
  const chats = entries.map(entry => entry.summary)
  const filter = String(query.get('q') ?? '').trim().toLowerCase()
  const hereChats = chats.filter(chat => chat.isHere)
  // "auto" lists this project's chats when it has any, otherwise all of them.
  const requested = query.get('scope') ?? 'here'
  const isHereScope = requested === 'here' || (requested === 'auto' && hereChats.length > 0)
  let selected = isHereScope ? hereChats : chats
  if (filter) {
    selected = selected.filter(chat => `${chat.title} ${chat.project} ${chat.machine} ${chat.branch}`.toLowerCase().includes(filter))
  }
  const limit = clampInt(query.get('limit'), DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT)
  return {
    here: here ? { key: here.key, label: here.label, repo: here.repo } : null,
    scope: isHereScope ? 'here' : 'all',
    counts: { here: hereChats.length, all: chats.length },
    total: selected.length,
    chats: selected.slice(0, limit),
  }
}

function findChat(store, query) {
  const origin = query.get('origin')
  const id = query.get('ref') ?? query.get('id') ?? ''
  const matches = [...store.catalog.values()].filter(chat => chat.id === id && (!origin || chat.origin === origin))
  if (matches.length === 0) {
    const error = new Error(`No linked chat with id ${clip(id, 60)}`)
    error.statusCode = 404
    throw error
  }
  // Prefer another machine's copy, then the most recently active one.
  matches.sort((left, right) => {
    const leftIsLocal = left.origin === store.selfId ? 1 : 0
    const rightIsLocal = right.origin === store.selfId ? 1 : 0
    return leftIsLocal - rightIsLocal || store.describe(right).lastAt - store.describe(left).lastAt
  })
  return matches[0]
}

async function readChat(store, query) {
  const chat = findChat(store, query)
  const summary = summarize(store, chat, null)
  const records = await readSlim(store.chatPath(chat.origin, chat.dir, chat.id))
  const turns = buildTurns(mainBranch(records))
  const format = query.get('format') ?? ChatFormat.Turns
  if (format === ChatFormat.Markdown || format === ChatFormat.Context) {
    const maxChars = clampInt(query.get('maxChars'), DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS)
    const { markdown, omittedTurns } = turnsToMarkdown(turns, maxChars)
    const text = format === ChatFormat.Context ? contextBlock(summary, markdown) : markdown
    return { chat: summary, totalTurns: turns.length, omittedTurns, text }
  }
  const maxTurns = clampInt(query.get('maxTurns'), DEFAULT_TURNS, 0, MAX_TURNS) || MAX_TURNS
  const kept = turns.length > maxTurns ? [turns[0], ...turns.slice(turns.length - (maxTurns - 1))] : turns
  return {
    chat: summary,
    totalTurns: turns.length,
    omittedTurns: turns.length - kept.length,
    turns: kept.map(turn => ({
      role: turn.role,
      at: turn.at,
      text: clip(turn.text, TURN_TEXT_LIMIT),
      tools: turn.tools.map(tool => ({ name: tool.name, input: clip(tool.input, 160), isError: tool.isError })),
    })),
  }
}

async function searchChats(store, query) {
  const needle = String(query.get('q') ?? '').trim().toLowerCase()
  if (needle.length < 2) {
    const error = new Error('Search needs at least 2 characters')
    error.statusCode = 400
    throw error
  }
  const { entries } = await candidates(store, query)
  const limit = clampInt(query.get('limit'), 20, 1, MAX_SEARCH_HITS)
  const hits = []
  for (const { chat, summary } of entries) {
    if (hits.length >= limit) {
      break
    }
    if (summary.title.toLowerCase().includes(needle)) {
      hits.push({ chat: summary, snippet: { role: 'title', text: summary.title } })
      continue
    }
    const content = await fs.readFile(store.chatPath(chat.origin, chat.dir, chat.id), 'utf8').catch(() => '')
    if (!content.toLowerCase().includes(needle)) {
      continue
    }
    const snippet = findSnippet(parseSlim(content), needle)
    if (snippet) {
      hits.push({ chat: summary, snippet })
    }
  }
  return { query: needle, hits }
}
