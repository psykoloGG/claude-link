import { promises as fs } from 'node:fs'

// Turns Claude Code transcript records into the compact records Claude Link
// stores and syncs: prompts, replies, tool calls and short tool results.
// Images, thinking blocks and bookkeeping rows are dropped, which shrinks a
// transcript full of screenshots to a small fraction of its size.
//
// Each slim record keeps the source row's uuid (u) and parent (p) so a reader
// can follow the conversation's main branch and skip abandoned rewinds.
export const SLIM_VERSION = 1

export const Role = Object.freeze({
  User: 'user',
  Assistant: 'assistant',
  Tool: 'tool',
  Result: 'result',
  Compact: 'compact',
})

const Limits = Object.freeze({
  userText: 20000,
  assistantText: 40000,
  toolInput: 400,
  toolResult: 1200,
  title: 200,
  firstPrompt: 200,
})

const READ_CHUNK_BYTES = 4 * 1024 * 1024
const PEEK_BYTES = 256 * 1024
const NEWLINE = 0x0a
const INTERRUPTION_PREFIX = '[Request interrupted'

export function emptyMeta() {
  return {
    cwd: '',
    branch: '',
    entrypoint: '',
    firstAt: 0,
    lastAt: 0,
    prompts: 0,
    replies: 0,
    aiTitle: '',
    customTitle: '',
    firstPrompt: '',
  }
}

export function clip(value, maxLength) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength)} [+${text.length - maxLength} chars]`
}

export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

// Converts one parsed transcript row, updating the session's running meta.
export function slimRecord(raw, meta) {
  if (!raw || typeof raw !== 'object') {
    return []
  }
  if (raw.type === 'ai-title') {
    meta.aiTitle = clip(oneLine(raw.aiTitle), Limits.title)
    return []
  }
  if (raw.type === 'custom-title') {
    meta.customTitle = clip(oneLine(raw.customTitle), Limits.title)
    return []
  }
  // Subagent rows live on side chains and never sit on the main branch.
  if (raw.isSidechain) {
    return []
  }
  if (raw.type === 'user') {
    return slimUser(raw, meta)
  }
  if (raw.type === 'assistant') {
    return slimAssistant(raw, meta)
  }
  if (raw.type === 'system') {
    return slimSystem(raw, meta)
  }
  if (raw.type === 'attachment') {
    noteContext(raw, meta)
    return linkOnly(raw)
  }
  return []
}

function parentOf(raw) {
  return raw.parentUuid ?? raw.logicalParentUuid ?? null
}

function linkOnly(raw) {
  return raw.uuid ? [{ u: raw.uuid, p: parentOf(raw) }] : []
}

function base(raw, at) {
  return { u: raw.uuid, p: parentOf(raw), t: at }
}

function noteContext(raw, meta) {
  if (typeof raw.cwd === 'string' && raw.cwd && !meta.cwd) {
    meta.cwd = raw.cwd
  }
  if (typeof raw.gitBranch === 'string' && raw.gitBranch) {
    meta.branch = raw.gitBranch
  }
  if (typeof raw.entrypoint === 'string' && raw.entrypoint && !meta.entrypoint) {
    meta.entrypoint = raw.entrypoint
  }
  const at = Date.parse(raw.timestamp)
  if (!Number.isFinite(at)) {
    return 0
  }
  if (!meta.firstAt || at < meta.firstAt) {
    meta.firstAt = at
  }
  if (at > meta.lastAt) {
    meta.lastAt = at
  }
  return at
}

function slimUser(raw, meta) {
  const at = noteContext(raw, meta)
  if (!raw.uuid) {
    return []
  }
  // Meta rows are skill bodies, caveats and compaction summaries the engine
  // injected; the person never typed them.
  if (raw.isMeta || raw.isCompactSummary || raw.isVisibleInTranscriptOnly) {
    return linkOnly(raw)
  }
  const content = raw.message?.content
  const records = []
  if (typeof content === 'string') {
    const text = userText(content)
    if (text) {
      records.push({ ...base(raw, at), r: Role.User, x: text })
    }
  } else if (Array.isArray(content)) {
    const texts = []
    let attachments = 0
    for (const block of content) {
      if (block?.type === 'text') {
        const text = userText(block.text)
        if (text) {
          texts.push(text)
        }
      } else if (block?.type === 'image' || block?.type === 'document') {
        attachments += 1
      } else if (block?.type === 'tool_result') {
        const result = { ...base(raw, at), r: Role.Result, c: String(block.tool_use_id ?? ''), x: resultText(block.content) }
        if (block.is_error) {
          result.e = 1
        }
        records.push(result)
      }
    }
    if (attachments > 0) {
      texts.push(attachments === 1 ? '[1 attachment]' : `[${attachments} attachments]`)
    }
    if (texts.length > 0) {
      records.push({ ...base(raw, at), r: Role.User, x: clip(texts.join('\n\n'), Limits.userText) })
    }
  }
  for (const record of records) {
    if (record.r === Role.User && !record.x.startsWith(INTERRUPTION_PREFIX)) {
      meta.prompts += 1
      if (!meta.firstPrompt) {
        meta.firstPrompt = clip(oneLine(record.x), Limits.firstPrompt)
      }
    }
  }
  return records.length > 0 ? records : linkOnly(raw)
}

// Slash commands become "/name args"; command output, caveats and system
// reminders are dropped since they are not what the person wrote.
function userText(value) {
  if (typeof value !== 'string') {
    return ''
  }
  const command = /<command-name>([^<]*)<\/command-name>/.exec(value)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(value)
    return clip(`${command[1].trim()} ${args ? args[1].trim() : ''}`.trim(), Limits.userText)
  }
  if (/^<local-command-(stdout|stderr|caveat)>/.test(value)) {
    return ''
  }
  return clip(value.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim(), Limits.userText)
}

function slimAssistant(raw, meta) {
  const at = noteContext(raw, meta)
  if (!raw.uuid) {
    return []
  }
  const content = raw.message?.content
  const records = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      records.push({ ...base(raw, at), r: Role.Assistant, x: clip(block.text.trim(), Limits.assistantText) })
      meta.replies += 1
    } else if (block?.type === 'tool_use') {
      const name = String(block.name ?? 'tool')
      records.push({ ...base(raw, at), r: Role.Tool, n: name, i: toolSummary(name, block.input), c: String(block.id ?? '') })
    }
  }
  return records.length > 0 ? records : linkOnly(raw)
}

function slimSystem(raw, meta) {
  const at = noteContext(raw, meta)
  if (!raw.uuid) {
    return []
  }
  if (raw.subtype === 'compact_boundary') {
    return [{ ...base(raw, at), r: Role.Compact }]
  }
  return linkOnly(raw)
}

// One readable line per tool call: the command, file or query it acted on.
function toolSummary(name, input) {
  if (!input || typeof input !== 'object') {
    return ''
  }
  const pick = (...keys) => keys.map(key => input[key]).find(value => typeof value === 'string' && value)
  let summary = ''
  switch (name) {
    case 'Bash':
      summary = pick('command')
      break
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      summary = pick('file_path', 'notebook_path')
      break
    case 'Grep':
      summary = [pick('pattern'), pick('path', 'glob')].filter(Boolean).join(' in ')
      break
    case 'Glob':
      summary = pick('pattern')
      break
    case 'WebFetch':
      summary = pick('url')
      break
    case 'WebSearch':
      summary = pick('query')
      break
    case 'Agent':
    case 'Task':
      summary = pick('description', 'prompt')
      break
    case 'Skill':
      summary = [pick('skill'), pick('args')].filter(Boolean).join(' ')
      break
    case 'TodoWrite':
      summary = Array.isArray(input.todos) ? `${input.todos.length} todos` : ''
      break
    default:
      summary = pick('command', 'file_path', 'path', 'url', 'query', 'pattern', 'description', 'prompt', 'name', 'title') ?? JSON.stringify(input)
  }
  return clip(oneLine(summary), Limits.toolInput)
}

function resultText(content) {
  if (typeof content === 'string') {
    return clip(content.trim(), Limits.toolResult)
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block?.type === 'image') {
      parts.push('[image]')
    }
  }
  return clip(parts.join('\n').trim(), Limits.toolResult)
}

// Reads the transcript from `fromByte`, converts each complete line and hands
// the slim lines to `emit`. Returns the offset after the last complete line,
// so a line Claude Code is still writing is picked up on the next pass.
export async function convertTranscript(sourcePath, fromByte, meta, emit) {
  const handle = await fs.open(sourcePath, 'r')
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let position = fromByte
    let parsedBytes = fromByte
    let carry = Buffer.alloc(0)
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(READ_CHUNK_BYTES, size - position), position)
      if (bytesRead === 0) {
        break
      }
      position += bytesRead
      const chunk = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
      const lastNewline = chunk.lastIndexOf(NEWLINE)
      if (lastNewline === -1) {
        carry = Buffer.from(chunk)
        continue
      }
      const complete = chunk.subarray(0, lastNewline + 1)
      carry = Buffer.from(chunk.subarray(lastNewline + 1))
      parsedBytes += complete.length
      const lines = convertLines(complete, meta)
      if (lines.length > 0) {
        await emit(`${lines.join('\n')}\n`)
      }
    }
    return parsedBytes
  } finally {
    await handle.close()
  }
}

function convertLines(complete, meta) {
  const lines = []
  let start = 0
  while (start < complete.length) {
    const end = complete.indexOf(NEWLINE, start)
    const line = complete.toString('utf8', start, end)
    start = end + 1
    if (!line.trim()) {
      continue
    }
    let raw = null
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    for (const record of slimRecord(raw, meta)) {
      lines.push(JSON.stringify(record))
    }
  }
  return lines
}

// The working directory recorded near the top of a transcript, read without
// converting the whole file (used to skip excluded projects early).
export async function peekCwd(sourcePath) {
  const handle = await fs.open(sourcePath, 'r')
  try {
    const buffer = Buffer.alloc(PEEK_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, PEEK_BYTES, 0)
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      try {
        const raw = JSON.parse(line)
        if (typeof raw?.cwd === 'string' && raw.cwd) {
          return raw.cwd
        }
      } catch {
        // A partial last line, or a row that is not JSON.
      }
    }
    return ''
  } finally {
    await handle.close()
  }
}
