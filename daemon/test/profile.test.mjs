import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkPairScope, makePairCode, readPairCode } from '../lib/config.mjs'
import { callPeer, PeerOp } from '../lib/peer.mjs'
import { clientMatches, readRegistryProfile, resolveEnrollment, rootsOverlap, validateScope, verifyBinding } from '../lib/profile.mjs'
import { Channel, deriveKey, open, seal } from '../lib/seal.mjs'

// Everything here runs against synthetic homes in a temp folder: two
// simulated machines, each with the default (legacy) setup and two named
// profiles whose chats share ids on purpose.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'claude-link.mjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const SHARED_ID = '33333333-3333-4333-8333-333333333333'
const SHARED_DIR = '-Users-alex-Shop'

async function tempRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-link-profiles-')))
}

// Runs a test body with HOME (and the folders derived from it) pointing into
// a synthetic home, restoring the environment afterwards.
async function withHome(home, body) {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, CLAUDE_LINK_HOME: process.env.CLAUDE_LINK_HOME, CLAUDE_LINK_PROFILES_HOME: process.env.CLAUDE_LINK_PROFILES_HOME }
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = path.join(home, '.config')
  delete process.env.CLAUDE_LINK_HOME
  delete process.env.CLAUDE_LINK_PROFILES_HOME
  try {
    return await body()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
}

function envFor(home) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }
  for (const name of ['CLAUDE_LINK_HOME', 'CLAUDE_LINK_PROFILES_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_LINK_DEBUG']) {
    delete env[name]
  }
  return env
}

function run(home, args, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...envFor(home), ...extraEnv } })
    let output = ''
    child.stdout.on('data', data => {
      output += data
    })
    child.stderr.on('data', data => {
      output += data
    })
    child.on('exit', code => resolve({ code, output }))
  })
}

async function ok(home, args, extraEnv) {
  const result = await run(home, args, extraEnv)
  assert.equal(result.code, 0, `${args.join(' ')} failed: ${result.output}`)
  return result.output
}

async function digest(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

async function writeRegistry(home, profiles, extra = {}) {
  const file = path.join(home, '.config', 'claude-multiprofile', 'profiles.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ version: 1, profiles, ...extra }, null, 2))
  return file
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

// ---- Unit level ----

test('a sync scope is explicit and short, and "default" is reserved', () => {
  assert.equal(validateScope('work'), 'work')
  assert.equal(validateScope('client-2'), 'client-2')
  for (const bad of ['', 'Work', 'default', 'a b', '../x', 'x'.repeat(33), undefined]) {
    assert.throws(() => validateScope(bad))
  }
})

test('a message sealed for one profile opens in no other, and the default derivation is unchanged', () => {
  const linkKey = randomBytes(32).toString('base64url')
  const sealed = seal(deriveKey(linkKey, 'work'), Channel.Request, { op: 'hello' })
  assert.deepEqual(open(deriveKey(linkKey, 'work'), Channel.Request, sealed, 1024), { op: 'hello' })
  assert.equal(open(deriveKey(linkKey, 'personal'), Channel.Request, sealed, 1024), null)
  assert.equal(open(deriveKey(linkKey), Channel.Request, sealed, 1024), null)
  assert.deepEqual(deriveKey(linkKey, ''), deriveKey(linkKey))
})

test('pairing codes join only the instance of the same profile', () => {
  const base = { linkKey: randomBytes(32).toString('base64url'), machineName: 'Desktop', machineId: '7d3f5a52-0000-4000-8000-000000000001', peerPort: 47611 }
  const defaultCode = makePairCode(base)
  const workCode = makePairCode({ ...base, profile: { scope: 'work' } })
  assert.ok(defaultCode.startsWith('clink1.'))
  assert.ok(workCode.startsWith('clinkp1.'))
  assert.equal(readPairCode(defaultCode).scope, '')
  assert.equal(readPairCode(workCode).scope, 'work')
  assert.equal(readPairCode(workCode).peerPort, 47611)
  checkPairScope({}, readPairCode(defaultCode))
  checkPairScope({ profile: { scope: 'work' } }, readPairCode(workCode))
  assert.throws(() => checkPairScope({}, readPairCode(workCode)), /work/)
  assert.throws(() => checkPairScope({ profile: { scope: 'work' } }, readPairCode(defaultCode)), /default/)
  assert.throws(() => checkPairScope({ profile: { scope: 'personal' } }, readPairCode(workCode)), /work/)
  // A scoped payload smuggled under the default prefix is refused.
  const forged = `clink1.${Buffer.from(JSON.stringify({ key: base.linkKey, name: 'x', id: base.machineId, urls: [], scope: 'work' })).toString('base64url')}`
  assert.throws(() => readPairCode(forged))
  assert.throws(() => readPairCode('clinkp1.!!!'))
})

test('the registry is read for one named profile only, and fails closed', async t => {
  const root = await tempRoot()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  await withHome(home, async () => {
    await assert.rejects(readRegistryProfile('work'), /No claude-multiprofile registry/)
    const file = await writeRegistry(home, [])
    await fs.writeFile(file, '{ not json')
    await assert.rejects(readRegistryProfile('work'), /not valid JSON/)
    await writeRegistry(home, [], { version: 2 })
    await assert.rejects(readRegistryProfile('work'), /not version 1/)
    await writeRegistry(home, [
      { name: 'work', code: { configDir: '/x/work code' }, desktop: { dataDir: '/x/Work Desktop' } },
      { name: 'desk', code: null, desktop: { dataDir: '/x/desk' } },
      { name: 'twice', code: { configDir: '/a' } },
      { name: 'twice', code: { configDir: '/b' } },
    ])
    await fs.chmod(file, 0o444)
    const before = await digest(file)
    assert.deepEqual(await readRegistryProfile('work'), { codeDir: '/x/work code', desktopDir: '/x/Work Desktop' })
    await assert.rejects(readRegistryProfile('desk'), /Unsupported: .*Desktop only/)
    await assert.rejects(readRegistryProfile('twice'), /more than once/)
    await assert.rejects(readRegistryProfile('Work'), /not in the claude-multiprofile registry/)
    assert.equal(await digest(file), before)
  })
})

test('enrollment refuses the default root, its aliases, overlaps and taken ports', async t => {
  const root = await tempRoot()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  await withHome(home, async () => {
    const defaultRoot = path.join(home, '.claude')
    const workCode = path.join(home, 'Profiles', 'Work Code')
    await fs.mkdir(path.join(defaultRoot, 'projects'), { recursive: true })
    await fs.mkdir(workCode, { recursive: true })
    await fs.symlink(defaultRoot, path.join(home, 'alias-to-default'))
    await fs.symlink(workCode, path.join(home, 'alias-to-work'))

    for (const codeDir of [defaultRoot, path.join(defaultRoot, 'projects'), path.join(home, 'alias-to-default'), home]) {
      await assert.rejects(resolveEnrollment({ scope: 'work', codeDir }), /default/)
    }
    await assert.rejects(resolveEnrollment({ scope: 'work', codeDir: path.join(home, 'missing') }), /does not exist/)
    await assert.rejects(resolveEnrollment({ scope: 'work', codeDir: workCode, desktopDir: path.join(home, 'nope') }), /Desktop data folder does not exist/)
    const defaultDesktop = path.join(home, 'Library', 'Application Support', 'Claude')
    await fs.mkdir(defaultDesktop, { recursive: true })
    if (process.platform === 'darwin') {
      await assert.rejects(resolveEnrollment({ scope: 'work', codeDir: workCode, desktopDir: defaultDesktop }), /default Desktop/)
    }

    // Spaces, a symlinked alias: both resolve to the same canonical folder.
    const viaAlias = await resolveEnrollment({ scope: 'work', codeDir: path.join(home, 'alias-to-work'), portBase: '48410' })
    assert.equal(viaAlias.profile.codeDir, workCode)
    assert.equal(viaAlias.profile.desktopSessionsDir, null)
    assert.deepEqual(viaAlias.ports, { localPort: 48410, peerPort: 48411, discoveryPort: 48412 })

    // Once enrolled, the same folder (or one inside it) cannot be enrolled again.
    const workHome = path.join(home, '.claude-link-profiles', 'work')
    await fs.mkdir(workHome, { recursive: true })
    await fs.writeFile(path.join(workHome, 'config.json'), JSON.stringify({ profile: viaAlias.profile, claudeDir: workCode, ...viaAlias.ports }))
    await assert.rejects(resolveEnrollment({ scope: 'other', codeDir: workCode }), /already enrolled .*"work"/)
    await fs.mkdir(path.join(workCode, 'nested'))
    await assert.rejects(resolveEnrollment({ scope: 'other', codeDir: path.join(workCode, 'nested') }), /already enrolled/)

    const otherCode = path.join(home, 'Other')
    await fs.mkdir(otherCode)
    await assert.rejects(resolveEnrollment({ scope: 'other', codeDir: otherCode, portBase: '48410' }), /ports are taken/)
    await assert.rejects(resolveEnrollment({ scope: 'other', codeDir: otherCode, portBase: '47600' }), /ports are taken/)
    const blocker = await listen(48420)
    try {
      await assert.rejects(resolveEnrollment({ scope: 'other', codeDir: otherCode, portBase: '48420' }), /ports are taken/)
    } finally {
      blocker.close()
    }
    await assert.rejects(resolveEnrollment({ scope: 'other', profileName: 'x', codeDir: otherCode }), /either/)
  })
})

test('the local API only answers sessions of the profile it serves', async t => {
  const root = await tempRoot()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  await withHome(home, async () => {
    const defaultRoot = path.join(home, '.claude')
    const work = path.join(home, 'work code')
    await fs.mkdir(defaultRoot, { recursive: true })
    await fs.mkdir(work, { recursive: true })
    await fs.symlink(work, path.join(home, 'work-alias'))
    const named = { profile: { scope: 'work' } }
    // Mods from before this change send no header: fine for the default only.
    assert.equal(await clientMatches({}, defaultRoot, undefined), true)
    assert.equal(await clientMatches(named, work, undefined), false)
    assert.equal(await clientMatches({}, defaultRoot, ''), true)
    assert.equal(await clientMatches({}, defaultRoot, encodeURIComponent(work)), false)
    assert.equal(await clientMatches(named, work, encodeURIComponent(work)), true)
    assert.equal(await clientMatches(named, work, encodeURIComponent(path.join(home, 'work-alias'))), true)
    assert.equal(await clientMatches(named, work, ''), false)
    assert.equal(await clientMatches(named, work, encodeURIComponent(path.join(home, 'nowhere'))), false)
    assert.equal(await clientMatches(named, work, '%E0%A4%A'), false)
    assert.equal(rootsOverlap(work, path.join(work, 'x')), true)
    assert.equal(rootsOverlap(work, `${work}2`), false)
  })
})

test('a profile whose folder was renamed, removed or swapped does not serve', async t => {
  const root = await tempRoot()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  await withHome(home, async () => {
    const work = path.join(home, 'work')
    await fs.mkdir(work, { recursive: true })
    const config = { profile: { scope: 'work', codeDir: work, desktopDir: null }, claudeDir: work, localPort: 48430, peerPort: 48431, discoveryPort: 48432 }
    await verifyBinding(config)
    await assert.rejects(verifyBinding({ ...config, localPort: 47600 }), /default instance's ports/)
    await fs.rename(work, `${work}-renamed`)
    await assert.rejects(verifyBinding(config), /missing or moved/)
    await fs.symlink(`${work}-renamed`, work)
    await assert.rejects(verifyBinding(config), /missing or moved/)
  })
})

// ---- Two simulated machines, three instances each ----

function transcript(uuid, text, cwd) {
  return `${JSON.stringify({ type: 'user', uuid, parentUuid: null, timestamp: new Date().toISOString(), cwd, message: { role: 'user', content: text } })}\n`
}

async function seedChat(codeRoot, text, cwd = '/Users/alex/Shop') {
  const folder = path.join(codeRoot, 'projects', SHARED_DIR)
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, `${SHARED_ID}.jsonl`), transcript('u1', text, cwd))
}

async function seedDesktopTitle(dataDir, title) {
  const folder = path.join(dataDir, 'claude-code-sessions', 'account', 'org')
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, 'local_1.json'), JSON.stringify({ cliSessionId: SHARED_ID, title }))
}

async function readConfig(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function localApi(configFile, pathname, { root, token, method = 'GET' } = {}) {
  const config = await readConfig(configFile)
  const headers = { authorization: `Bearer ${token ?? config.localToken}` }
  if (root !== undefined) {
    headers['x-claude-link-root'] = encodeURIComponent(root)
  }
  const response = await fetch(`http://127.0.0.1:${config.localPort}${pathname}`, { method, headers })
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function waitFor(check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check().catch(() => null)
    if (value) {
      return value
    }
    await sleep(300)
  }
  throw new Error('Timed out waiting for the condition')
}

test('each profile syncs only with the same profile on the other machine', async t => {
  const root = await tempRoot()
  const machines = {}
  for (const name of ['a', 'b']) {
    const home = path.join(root, name)
    machines[name] = {
      home,
      defaultCode: path.join(home, '.claude'),
      // Different paths for the same profile on each machine: the scope, not
      // the path, is what pairs them.
      workCode: path.join(home, name === 'a' ? 'Profiles/Work Code' : 'elsewhere/claude work'),
      workDesktop: path.join(home, 'Library', 'Application Support', 'Claude Work'),
      personalCode: path.join(home, '.claude-personal'),
    }
    for (const folder of [machines[name].defaultCode, machines[name].workCode, machines[name].workDesktop, machines[name].personalCode]) {
      await fs.mkdir(folder, { recursive: true })
    }
  }
  const { a, b } = machines
  const daemons = []
  t.after(async () => {
    for (const daemon of daemons) {
      daemon.kill()
    }
    await sleep(300)
    await fs.rm(root, { recursive: true, force: true })
  })

  // The same chat id and project folder in every instance, different content.
  await seedChat(a.defaultCode, 'alpha default note')
  await seedChat(a.workCode, 'alpha work note')
  await seedChat(a.personalCode, 'alpha personal note')
  await seedChat(b.workCode, 'bravo work note')
  // Desktop titles: the default app's and the work profile's, same chat id.
  await seedDesktopTitle(path.join(a.home, 'Library', 'Application Support', 'Claude'), 'Default desktop title')
  await seedDesktopTitle(a.workDesktop, 'Work desktop title')

  // Machine A enrolls "work" from the registry (read only), B with explicit paths.
  const registry = await writeRegistry(a.home, [{ name: 'Work Profile', code: { configDir: a.workCode }, desktop: { dataDir: a.workDesktop } }])
  await fs.chmod(registry, 0o444)
  const registryBefore = await digest(registry)

  // Default (legacy) link, as before this change.
  await ok(a.home, ['init', '--name', 'Alpha'])
  const defaultCode = (await ok(a.home, ['pair-code'])).trim().split('\n').pop()
  await ok(b.home, ['join', defaultCode, '--name', 'Bravo'])
  const files = {
    aDefault: path.join(a.home, '.claude-link', 'config.json'),
    bDefault: path.join(b.home, '.claude-link', 'config.json'),
    aWork: path.join(a.home, '.claude-link-profiles', 'work', 'config.json'),
    bWork: path.join(b.home, '.claude-link-profiles', 'work', 'config.json'),
    aPersonal: path.join(a.home, '.claude-link-profiles', 'personal', 'config.json'),
    bPersonal: path.join(b.home, '.claude-link-profiles', 'personal', 'config.json'),
  }
  const ports = { aDefault: 48510, bDefault: 48520, aWork: 48530, bWork: 48540, aPersonal: 48550, bPersonal: 48560 }
  for (const [instance, port] of Object.entries({ aDefault: ports.aDefault, bDefault: ports.bDefault })) {
    const config = await readConfig(files[instance])
    Object.assign(config, { localPort: port, peerPort: port + 1, discoveryPort: port + 2, discovery: false, claudeDir: machines[instance[0]].defaultCode })
    await fs.writeFile(files[instance], JSON.stringify(config))
  }

  await ok(a.home, ['profile', 'enroll', '--scope', 'work', '--profile', 'Work Profile', '--name', 'Alpha', '--port-base', String(ports.aWork)])
  await ok(b.home, ['profile', 'enroll', '--scope', 'work', '--code-dir', b.workCode, '--name', 'Bravo', '--port-base', String(ports.bWork)])
  await ok(a.home, ['profile', 'enroll', '--scope', 'personal', '--code-dir', a.personalCode, '--name', 'Alpha', '--port-base', String(ports.aPersonal)])
  await ok(b.home, ['profile', 'enroll', '--scope', 'personal', '--code-dir', b.personalCode, '--name', 'Bravo', '--port-base', String(ports.bPersonal)])

  // Enrollment refusals through the CLI: default root, a taken folder, a reused port.
  assert.equal((await run(a.home, ['profile', 'enroll', '--scope', 'other', '--code-dir', a.defaultCode])).code, 3)
  assert.equal((await run(a.home, ['profile', 'enroll', '--scope', 'other', '--code-dir', a.workCode])).code, 3)
  const extra = path.join(a.home, 'extra')
  await fs.mkdir(extra)
  assert.equal((await run(a.home, ['profile', 'enroll', '--scope', 'other', '--code-dir', extra, '--port-base', String(ports.aWork)])).code, 3)
  assert.equal((await run(a.home, ['profile', 'enroll', '--scope', 'work', '--code-dir', extra])).code, 1, 'an enrolled scope is not silently re-bound')

  const workCode = (await ok(a.home, ['pair-code', '--scope', 'work'])).trim().split('\n').pop()
  const personalCode = (await ok(a.home, ['pair-code', '--scope', 'personal'])).trim().split('\n').pop()
  // Cross-profile joins are refused and change nothing.
  const bPersonalBefore = await digest(files.bPersonal)
  const bDefaultBefore = await digest(files.bDefault)
  const bWorkBefore = await digest(files.bWork)
  assert.match((await run(b.home, ['join', workCode, '--scope', 'personal'])).output, /"work" profile/)
  assert.match((await run(b.home, ['join', defaultCode, '--scope', 'work'])).output, /default profile/)
  assert.match((await run(b.home, ['join', workCode])).output, /"work" profile/)
  assert.equal(await digest(files.bPersonal), bPersonalBefore)
  assert.equal(await digest(files.bDefault), bDefaultBefore)
  assert.equal(await digest(files.bWork), bWorkBefore)
  assert.notEqual((await run(path.join(root, 'fresh'), ['join', workCode, '--scope', 'work'])).code, 0, 'a profile must be enrolled before it joins')

  await ok(b.home, ['join', workCode, '--scope', 'work'])
  await ok(b.home, ['join', personalCode, '--scope', 'personal'])

  // Separate identity, key, token and ports per instance.
  const configs = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await readConfig(file)])))
  for (const field of ['machineId', 'localToken']) {
    assert.equal(new Set(Object.values(configs).map(config => config[field])).size, 6, field)
  }
  assert.equal(new Set([configs.aDefault.linkKey, configs.aWork.linkKey, configs.aPersonal.linkKey]).size, 3)
  assert.equal(configs.bWork.linkKey, configs.aWork.linkKey)
  assert.equal(configs.bWork.peers[0].sshPort, ports.aWork + 1)
  assert.equal(configs.aWork.autoUpdate, false)
  assert.equal(configs.aDefault.profile, undefined)
  for (const name of ['bDefault', 'bWork', 'bPersonal']) {
    const other = `a${name.slice(1)}`
    const config = configs[name]
    config.discovery = false
    config.peers = [{ name: 'Alpha', machineId: configs[other].machineId, urls: [`http://127.0.0.1:${configs[other].peerPort}`] }]
    await fs.writeFile(files[name], JSON.stringify(config))
  }
  for (const name of ['aWork', 'aPersonal']) {
    configs[name].discovery = false
    await fs.writeFile(files[name], JSON.stringify(configs[name]))
  }

  const serve = (home, args) => {
    const daemon = spawn(process.execPath, [CLI, 'serve', ...args], { env: envFor(home), stdio: 'ignore' })
    daemons.push(daemon)
    return daemon
  }
  serve(a.home, [])
  serve(b.home, [])
  serve(a.home, ['--scope', 'work'])
  serve(b.home, ['--scope', 'work'])
  serve(a.home, ['--scope', 'personal'])
  serve(b.home, ['--scope', 'personal'])

  const listFrom = (file, root) => localApi(file, '/api/chats?scope=all', { root })
  const titlesSeen = async (file, root, count = 1) => {
    const { status, body } = await listFrom(file, root)
    return status === 200 && body.chats.length === count ? body.chats.map(chat => chat.title) : null
  }

  // B's work instance sees A's work chat with the work Desktop title, never
  // the default or personal chat that share its id.
  assert.deepEqual(await waitFor(() => titlesSeen(files.bWork, b.workCode)), ['Work desktop title'])
  assert.deepEqual(await waitFor(() => titlesSeen(files.bPersonal, b.personalCode)), ['alpha personal note'])
  const defaultTitles = await waitFor(() => titlesSeen(files.bDefault, ''))
  assert.deepEqual(defaultTitles, [process.platform === 'darwin' ? 'Default desktop title' : 'alpha default note'])
  // Reciprocal: A's work instance gets B's work chat.
  assert.deepEqual(await waitFor(() => titlesSeen(files.aWork, a.workCode)), ['bravo work note'])

  // Search stays inside the profile.
  const workSearch = await localApi(files.bWork, '/api/search?q=personal', { root: b.workCode })
  assert.equal(workSearch.status, 200)
  assert.equal(workSearch.body.hits.length, 0)
  const workRead = await localApi(files.bWork, `/api/chat?ref=${SHARED_ID}&format=markdown`, { root: b.workCode })
  assert.match(workRead.body.text, /alpha work note/)
  assert.doesNotMatch(workRead.body.text, /default|personal/)

  // Requests from other profiles' sessions are refused, not answered with a fallback.
  assert.equal((await listFrom(files.bWork, b.personalCode)).status, 409)
  assert.equal((await listFrom(files.bWork, '')).status, 409)
  assert.equal((await listFrom(files.bWork, undefined)).status, 409)
  assert.equal((await listFrom(files.bDefault, b.workCode)).status, 409)
  assert.equal((await listFrom(files.bDefault, undefined)).status, 200, 'a mod from before profiles still works with the default instance')
  assert.equal((await localApi(files.bWork, '/api/chats', { root: b.workCode, token: configs.bDefault.localToken })).status, 401)
  const status = await localApi(files.bWork, '/api/status', { root: b.workCode })
  assert.equal(status.body.profile.scope, 'work')
  assert.match(await ok(b.home, ['status', '--scope', 'work']), /\[profile work\]/)
  assert.doesNotMatch(await ok(b.home, ['status']), /profile/)

  // Peer doors: the work key without the work scope, or with another scope,
  // opens nothing; nor does the default key on the work port.
  const workPeer = `http://127.0.0.1:${configs.bWork.peerPort}`
  const hello = key => callPeer({ url: workPeer, key, selfId: configs.aPersonal.machineId, op: PeerOp.Manifest, args: {}, timeoutMs: 3000 })
  await assert.rejects(hello(deriveKey(configs.aWork.linkKey)), /401/)
  await assert.rejects(hello(deriveKey(configs.aWork.linkKey, 'personal')), /401/)
  await assert.rejects(hello(deriveKey(configs.aDefault.linkKey)), /401/)
  const manifest = await hello(deriveKey(configs.aWork.linkKey, 'work'))
  assert.ok(manifest.entries.every(entry => entry.meta.title !== 'alpha personal note'))

  // A second daemon for the same profile cannot take its ports.
  const duplicate = await run(b.home, ['serve', '--scope', 'work'])
  assert.equal(duplicate.code, 3)

  // install-mod writes the profile's own settings only, with its own instance.
  const defaultSettings = path.join(b.defaultCode, 'settings.json')
  await fs.writeFile(defaultSettings, JSON.stringify({ env: { KEEP: '1' } }))
  const defaultSettingsBefore = await digest(defaultSettings)
  await ok(b.home, ['install-mod', '--scope', 'work'])
  const workSettings = await readConfig(path.join(b.workCode, 'settings.json'))
  assert.equal(workSettings.env.CLAUDE_LINK_HOME, path.join(b.home, '.claude-link-profiles', 'work'))
  assert.equal(workSettings.env.CLAUDE_CODE_PLUGIN_DIRS, path.join(b.home, '.claude-link-profiles', 'work', 'mod'))
  assert.equal(await digest(defaultSettings), defaultSettingsBefore)
  assert.notEqual((await run(b.home, ['install-mod'], { CLAUDE_CONFIG_DIR: b.workCode })).code, 0, 'the default mod never lands in a profile')
  await ok(b.home, ['uninstall-mod', '--scope', 'work'])
  assert.equal((await readConfig(path.join(b.workCode, 'settings.json'))).env.CLAUDE_LINK_HOME, undefined)

  // Copying a profile's config into another profile's folder does not make it serve there.
  const stray = path.join(b.home, '.claude-link-profiles', 'stray')
  await fs.mkdir(stray)
  await fs.copyFile(files.bWork, path.join(stray, 'config.json'))
  assert.match((await run(b.home, ['status', '--scope', 'stray'])).output, /belongs to the "work" profile/)

  // A removed or renamed profile folder fails closed and says so.
  for (const daemon of daemons.splice(4)) {
    daemon.kill()
  }
  await sleep(300)
  await fs.rename(a.personalCode, `${a.personalCode}-old`)
  const moved = await run(a.home, ['serve', '--scope', 'personal'])
  assert.equal(moved.code, 3)
  assert.match(moved.output, /missing or moved/)
  assert.doesNotMatch(moved.output, new RegExp(a.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal((await run(a.home, ['profile', 'status', '--scope', 'personal'])).code, 1)
  assert.match(await ok(a.home, ['profile', 'status', '--scope', 'work']), /Binding OK/)
  assert.match((await run(a.home, ['status', '--scope', 'nobody'])).output, /No link config/)

  // The registry was only ever read.
  assert.equal(await digest(registry), registryBefore)
  assert.equal(((await fs.stat(registry)).mode & 0o777), 0o444)
})
