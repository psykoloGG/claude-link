import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import { isSameOrNested } from '../lib/api.mjs'
import { bundleHash, isNewer, validateFiles } from '../lib/bundle.mjs'
import { buildTurns, findSnippet, mainBranch, turnsToMarkdown } from '../lib/render.mjs'
import { Channel, ReplayGuard, deriveKey, newNonce, open, seal } from '../lib/seal.mjs'
import { Role, emptyMeta, slimRecord } from '../lib/slim.mjs'
import { projectInfo } from '../lib/store.mjs'

const key = deriveKey(randomBytes(32).toString('base64url'))

test('a sealed message opens only with the same key and channel', () => {
  const sealed = seal(key, Channel.Request, { op: 'hello', count: 3 })
  assert.deepEqual(open(key, Channel.Request, sealed, 1024), { op: 'hello', count: 3 })
  assert.equal(open(key, Channel.Response, sealed, 1024), null)
  assert.equal(open(deriveKey(randomBytes(32).toString('base64url')), Channel.Request, sealed, 1024), null)
  const tampered = Buffer.from(sealed)
  tampered[20] ^= 1
  assert.equal(open(key, Channel.Request, tampered, 1024), null)
})

test('a short link key is refused', () => {
  assert.throws(() => deriveKey(randomBytes(8).toString('base64url')))
})

test('the replay guard refuses repeats and stale messages', () => {
  const guard = new ReplayGuard(1000)
  const nonce = newNonce()
  assert.equal(guard.accept(nonce, Date.now()), true)
  assert.equal(guard.accept(nonce, Date.now()), false)
  assert.equal(guard.accept(newNonce(), Date.now() - 5000), false)
})

function user(uuid, parent, content, extra = {}) {
  return { type: 'user', uuid, parentUuid: parent, timestamp: '2026-10-01T10:00:00.000Z', cwd: '/Users/alex/Project', message: { role: 'user', content }, ...extra }
}

function assistant(uuid, parent, content) {
  return { type: 'assistant', uuid, parentUuid: parent, timestamp: '2026-10-01T10:00:05.000Z', message: { role: 'assistant', content } }
}

test('slimming keeps prompts, replies and tool calls and drops the rest', () => {
  const meta = emptyMeta()
  const rows = [
    user('u1', null, 'Fix the build <system-reminder>secret context</system-reminder>'),
    assistant('a1', 'u1', [{ type: 'thinking', thinking: 'hmm', signature: 'x'.repeat(500) }, { type: 'text', text: 'Looking.' }]),
    assistant('a2', 'a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }]),
    user('r1', 'a2', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: true }]),
    user('m1', 'r1', 'injected skill body', { isMeta: true }),
    user('s1', null, 'subagent prompt', { isSidechain: true }),
    { type: 'ai-title', aiTitle: 'Build fix' },
    { type: 'custom-title', customTitle: 'My build fix' },
    user('c1', 'm1', '<command-name>/model</command-name>\n<command-args>opus</command-args>'),
  ]
  const records = rows.flatMap(row => slimRecord(row, meta))
  assert.deepEqual(records.filter(record => record.r).map(record => record.r), [Role.User, Role.Assistant, Role.Tool, Role.Result, Role.User])
  assert.equal(records[0].x, 'Fix the build')
  assert.equal(records.find(record => record.r === Role.Tool).i, 'npm run build')
  assert.equal(records.find(record => record.r === Role.Result).e, 1)
  assert.equal(records.find(record => record.u === 'm1').r, undefined)
  assert.equal(records.some(record => record.u === 's1'), false)
  assert.equal(records.at(-1).x, '/model opus')
  assert.equal(meta.prompts, 2)
  assert.equal(meta.aiTitle, 'Build fix')
  assert.equal(meta.customTitle, 'My build fix')
  assert.equal(meta.cwd, '/Users/alex/Project')
  assert.equal(JSON.stringify(records).includes('secret context'), false)
})

test('the main branch skips turns a rewind abandoned', () => {
  const meta = emptyMeta()
  const rows = [
    user('u1', null, 'first'),
    assistant('a1', 'u1', [{ type: 'text', text: 'answer one' }]),
    user('u2', 'a1', 'abandoned question'),
    assistant('a2', 'u2', [{ type: 'text', text: 'abandoned answer' }]),
    user('u3', 'a1', 'edited question'),
    assistant('a3', 'u3', [{ type: 'text', text: 'final answer' }]),
  ]
  const turns = buildTurns(mainBranch(rows.flatMap(row => slimRecord(row, meta))))
  assert.deepEqual(turns.map(turn => turn.text), ['first', 'answer one', 'edited question', 'final answer'])
})

test('a compaction boundary keeps the history before it', () => {
  const meta = emptyMeta()
  const rows = [
    user('u1', null, 'before compaction'),
    assistant('a1', 'u1', [{ type: 'text', text: 'old answer' }]),
    { type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'a1', timestamp: '2026-10-01T11:00:00.000Z' },
    user('u2', 'b1', 'after compaction'),
  ]
  const turns = buildTurns(mainBranch(rows.flatMap(row => slimRecord(row, meta))))
  assert.deepEqual(turns.map(turn => turn.role), ['user', 'assistant', 'note', 'user'])
})

test('markdown within a budget keeps the opening prompt and the latest turns', () => {
  const turns = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', at: 0, text: `turn ${index} ${'x'.repeat(200)}`, tools: [] }))
  const { markdown, omittedTurns } = turnsToMarkdown(turns, 2500)
  assert.ok(markdown.includes('turn 0 '))
  assert.ok(markdown.includes('turn 29 '))
  assert.ok(!markdown.includes('turn 10 '))
  assert.ok(omittedTurns > 0)
  assert.ok(markdown.length < 3200)
})

test('snippets prefer what was written over tool inputs', () => {
  const records = [
    { u: '1', r: Role.Tool, n: 'Bash', i: 'grep stripe' },
    { u: '2', r: Role.Assistant, x: 'Stripe checkout is wired up.' },
  ]
  assert.equal(findSnippet(records, 'stripe').role, Role.Assistant)
})

test('a project is the same on Windows and macOS when it sits at the same place in home', () => {
  const mac = projectInfo('/Users/alex/Desktop/Projects/Webshop', '/Users/alex')
  const windows = projectInfo('C:\\Users\\alex\\Desktop\\Projects\\Webshop', 'C:\\Users\\alex')
  assert.equal(mac.key, 'desktop/projects/webshop')
  assert.equal(windows.key, mac.key)
  assert.equal(projectInfo('/Users/alex/.notes', '/Users/alex').label, 'notes')
  assert.equal(projectInfo('/Users/alex/Repo/.claude/worktrees/feature-x', '/Users/alex').key, 'repo')
})

test('a build only accepts files inside app/ and mod/', () => {
  const build = [
    { path: 'app/claude-link.mjs', content: 'serve' },
    { path: 'mod/.claude-plugin/plugin.json', content: '{}' },
  ]
  assert.doesNotThrow(() => validateFiles(build))
  assert.throws(() => validateFiles([...build, { path: 'app/../../.ssh/authorized_keys', content: 'x' }]))
  assert.throws(() => validateFiles([...build, { path: '/etc/hosts', content: 'x' }]))
  assert.throws(() => validateFiles([...build, { path: 'scripts/run.sh', content: 'x' }]))
  assert.throws(() => validateFiles([{ path: 'app/claude-link.mjs', content: 'serve' }]))
})

test('a build is identified by its content, and only a newer different build replaces one', () => {
  const files = [{ path: 'app/a.mjs', content: 'one' }, { path: 'mod/b.tsx', content: 'two' }]
  assert.equal(bundleHash(files), bundleHash([...files].reverse()))
  assert.notEqual(bundleHash(files), bundleHash([{ path: 'app/a.mjs', content: 'changed' }, files[1]]))
  const current = { publishedAt: 100, hash: 'aaa' }
  assert.equal(isNewer({ publishedAt: 200, hash: 'bbb' }, current), true)
  assert.equal(isNewer({ publishedAt: 200, hash: 'aaa' }, current), false)
  assert.equal(isNewer({ publishedAt: 50, hash: 'bbb' }, current), false)
})

test('a subfolder of a project counts as the project, a broad folder does not', () => {
  assert.equal(isSameOrNested('desktop/personal/gameon graphics', 'desktop/personal/gameon graphics/plugins/source'), true)
  assert.equal(isSameOrNested('desktop/personal/gameon graphics/plugins', 'desktop/personal/gameon graphics'), true)
  assert.equal(isSameOrNested('desktop/projects', 'desktop/projects/webshop'), false)
  assert.equal(isSameOrNested('desktop/projects/webshop', 'desktop/projects/webshop-api'), false)
  assert.equal(isSameOrNested('.notes', '.notes'), true)
})
